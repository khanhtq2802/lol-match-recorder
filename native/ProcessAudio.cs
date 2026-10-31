// Captures the sound of one app (and its child processes) with WASAPI process loopback, so the
// recording gets the Discord voice chat without the game. Needs Windows 10 2004 or newer.
//
// Usage: process-audio.exe <pipe name> <process names, comma separated>
// Prints "ready" once the pipe exists, then writes 48 kHz 16-bit stereo PCM to it until the reader
// goes away. The stream never stops: it is silence while the app is closed or quiet, so it stays
// in sync with the video.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Threading;

static class Program
{
	public const int SampleRate = 48000;
	public const int BytesPerFrame = 4;
	const int BytesPerSecond = SampleRate * BytesPerFrame;
	// ffmpeg has this long to open the pipe, so the helper doesn't stay around when it never does
	const int ConnectTimeout = 15000;
	const int RetryInterval = 2000;
	// sound waits until this much is queued, to ride out packets that come late
	const int Prebuffer = BytesPerSecond * 30 / 1000;
	// more than this queued is clock drift: the oldest sound is dropped
	const int MaxQueued = BytesPerSecond * 200 / 1000;

	[MTAThread]
	static int Main(string[] args)
	{
		if (args.Length < 2)
		{
			Console.Error.WriteLine("usage: process-audio <pipe name> <process names>");
			return 2;
		}
		try
		{
			using (var pipe = new NamedPipeServerStream(args[0], PipeDirection.Out, 1,
				PipeTransmissionMode.Byte, PipeOptions.Asynchronous, BytesPerSecond, 0))
			{
				Console.Out.WriteLine("ready");
				Console.Out.Flush();
				var connection = pipe.BeginWaitForConnection(null, null);
				if (!connection.AsyncWaitHandle.WaitOne(ConnectTimeout)) return 1;
				pipe.EndWaitForConnection(connection);
				Pump(pipe, args[1].Split(','));
			}
			return 0;
		}
		catch (IOException)
		{
			// ffmpeg finished and closed the pipe
			return 0;
		}
	}

	static void Pump(Stream output, string[] processNames)
	{
		var queue = new byte[BytesPerSecond];
		var queued = 0;
		var playing = false;
		ProcessCapture capture = null;
		var nextTry = 0L;
		var clock = Stopwatch.StartNew();
		var writtenFrames = 0L;

		while (true)
		{
			if (capture == null && clock.ElapsedMilliseconds >= nextTry)
			{
				nextTry = clock.ElapsedMilliseconds + RetryInterval;
				capture = ProcessCapture.TryOpen(processNames);
			}
			if (capture == null)
			{
				Thread.Sleep(10);
			}
			else
			{
				try
				{
					capture.Read(queue, ref queued);
				}
				catch (Exception error)
				{
					// the app closed or the capture broke: silence until it can be opened again
					Console.Error.WriteLine("Capture ended: " + error.Message);
					capture.Dispose();
					capture = null;
				}
			}
			if (queued > MaxQueued) Dequeue(queue, ref queued, queued - Prebuffer);

			var frames = clock.ElapsedTicks * SampleRate / Stopwatch.Frequency - writtenFrames;
			if (frames <= 0) continue;

			if (queued >= Prebuffer) playing = true;
			var block = new byte[frames * BytesPerFrame];
			var sound = playing ? Math.Min(queued, block.Length) : 0;
			Buffer.BlockCopy(queue, 0, block, 0, sound);
			Dequeue(queue, ref queued, sound);
			if (sound < block.Length) playing = false;
			output.Write(block, 0, block.Length);
			writtenFrames += frames;
		}
	}

	static void Dequeue(byte[] queue, ref int queued, int count)
	{
		// whole frames only, else left and right swap
		count -= count % BytesPerFrame;
		Buffer.BlockCopy(queue, count, queue, 0, queued - count);
		queued -= count;
	}
}

sealed class ProcessCapture : IDisposable
{
	const string LoopbackDevice = "VAD\\Process_Loopback";
	const int ActivationTimeout = 5000;
	const uint StreamFlags = 0x00020000 /* LOOPBACK */ | 0x00040000 /* EVENTCALLBACK */ | 0x80000000 /* AUTOCONVERTPCM */;
	const uint SilentPacket = 0x2;
	// in 100 ns units
	const long BufferDuration = 2000000;

	readonly Process process;
	readonly IAudioClient client;
	readonly IAudioCaptureClient captureClient;
	readonly AutoResetEvent packetReady = new AutoResetEvent(false);

	/// <summary>Opens the capture of the first app running, null when there is none or it fails</summary>
	public static ProcessCapture TryOpen(string[] processNames)
	{
		var pid = FindRootProcess(processNames);
		if (pid == 0) return null;
		try
		{
			return new ProcessCapture(pid);
		}
		catch (Exception error)
		{
			Console.Error.WriteLine("Can't capture process " + pid + ": " + error.Message);
			return null;
		}
	}

	ProcessCapture(uint pid)
	{
		process = Process.GetProcessById((int)pid);
		client = Activate(pid);
		var format = new WaveFormat
		{
			FormatTag = 1,
			Channels = 2,
			SamplesPerSec = Program.SampleRate,
			AvgBytesPerSec = Program.SampleRate * Program.BytesPerFrame,
			BlockAlign = Program.BytesPerFrame,
			BitsPerSample = 16,
			Size = 0
		};
		Marshal.ThrowExceptionForHR(client.Initialize(0, StreamFlags, BufferDuration, 0, ref format, IntPtr.Zero));
		Marshal.ThrowExceptionForHR(client.SetEventHandle(packetReady.SafeWaitHandle.DangerousGetHandle()));
		var iid = typeof(IAudioCaptureClient).GUID;
		object service;
		Marshal.ThrowExceptionForHR(client.GetService(ref iid, out service));
		captureClient = (IAudioCaptureClient)service;
		Marshal.ThrowExceptionForHR(client.Start());
		Console.Error.WriteLine("Capturing " + process.ProcessName + " (" + pid + ")");
	}

	static IAudioClient Activate(uint pid)
	{
		var activationParams = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(ActivationParams)));
		var variant = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(BlobVariant)));
		try
		{
			Marshal.StructureToPtr(new ActivationParams
			{
				ActivationType = 1, // PROCESS_LOOPBACK
				TargetProcessId = pid,
				LoopbackMode = 0 // INCLUDE_TARGET_PROCESS_TREE
			}, activationParams, false);
			Marshal.StructureToPtr(new BlobVariant
			{
				Type = 65, // VT_BLOB
				Size = Marshal.SizeOf(typeof(ActivationParams)),
				Data = activationParams
			}, variant, false);

			var handler = new ActivationHandler();
			var iid = typeof(IAudioClient).GUID;
			IActivateAudioInterfaceAsyncOperation operation;
			Native.ActivateAudioInterfaceAsync(LoopbackDevice, ref iid, variant, handler, out operation);
			if (!handler.Done.WaitOne(ActivationTimeout)) throw new TimeoutException("Activation timed out");

			int result;
			object activated;
			operation.GetActivateResult(out result, out activated);
			Marshal.ThrowExceptionForHR(result);
			return (IAudioClient)activated;
		}
		finally
		{
			Marshal.FreeHGlobal(variant);
			Marshal.FreeHGlobal(activationParams);
		}
	}

	/// <summary>Waits for sound and appends it to the queue, throws when the app closed</summary>
	public void Read(byte[] queue, ref int queued)
	{
		if (process.HasExited) throw new InvalidOperationException("The app closed");
		packetReady.WaitOne(10);
		while (true)
		{
			uint packetFrames;
			Marshal.ThrowExceptionForHR(captureClient.GetNextPacketSize(out packetFrames));
			if (packetFrames == 0) return;

			IntPtr data;
			uint frames, flags;
			ulong devicePosition, qpcPosition;
			Marshal.ThrowExceptionForHR(captureClient.GetBuffer(out data, out frames, out flags, out devicePosition, out qpcPosition));
			var size = (int)frames * Program.BytesPerFrame;
			// full: only when the clocks are far off, the sound is dropped
			if (queued + size <= queue.Length)
			{
				if ((flags & SilentPacket) != 0) Array.Clear(queue, queued, size);
				else Marshal.Copy(data, queue, queued, size);
				queued += size;
			}
			Marshal.ThrowExceptionForHR(captureClient.ReleaseBuffer(frames));
		}
	}

	public void Dispose()
	{
		client.Stop();
		Marshal.ReleaseComObject(captureClient);
		Marshal.ReleaseComObject(client);
		process.Dispose();
		packetReady.Dispose();
	}

	/// <summary>The main process of the app, the voice chat plays in one of its children</summary>
	static uint FindRootProcess(string[] processNames)
	{
		var exeNames = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
		foreach (var name in processNames) exeNames.Add(name + ".exe");

		var parents = new Dictionary<uint, uint>();
		var snapshot = Native.CreateToolhelp32Snapshot(2 /* TH32CS_SNAPPROCESS */, 0);
		if (snapshot == new IntPtr(-1)) return 0;
		try
		{
			var entry = new ProcessEntry { Size = Marshal.SizeOf(typeof(ProcessEntry)) };
			for (var more = Native.Process32First(snapshot, ref entry); more; more = Native.Process32Next(snapshot, ref entry))
			{
				if (exeNames.Contains(entry.ExeFile)) parents[entry.ProcessId] = entry.ParentProcessId;
			}
		}
		finally
		{
			Native.CloseHandle(snapshot);
		}
		foreach (var process in parents)
		{
			if (!parents.ContainsKey(process.Value)) return process.Key;
		}
		return 0;
	}
}

sealed class ActivationHandler : IActivateAudioInterfaceCompletionHandler, IAgileObject
{
	public readonly ManualResetEvent Done = new ManualResetEvent(false);

	public void ActivateCompleted(IActivateAudioInterfaceAsyncOperation operation)
	{
		Done.Set();
	}
}

static class Native
{
	[DllImport("Mmdevapi.dll", ExactSpelling = true, PreserveSig = false)]
	public static extern void ActivateAudioInterfaceAsync(
		[MarshalAs(UnmanagedType.LPWStr)] string deviceInterfacePath,
		ref Guid riid,
		IntPtr activationParams,
		IActivateAudioInterfaceCompletionHandler completionHandler,
		out IActivateAudioInterfaceAsyncOperation operation);

	[DllImport("kernel32.dll", SetLastError = true)]
	public static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint processId);

	[DllImport("kernel32.dll", CharSet = CharSet.Unicode, EntryPoint = "Process32FirstW")]
	public static extern bool Process32First(IntPtr snapshot, ref ProcessEntry entry);

	[DllImport("kernel32.dll", CharSet = CharSet.Unicode, EntryPoint = "Process32NextW")]
	public static extern bool Process32Next(IntPtr snapshot, ref ProcessEntry entry);

	[DllImport("kernel32.dll")]
	public static extern bool CloseHandle(IntPtr handle);
}

[StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
struct ProcessEntry
{
	public int Size;
	public uint Usage;
	public uint ProcessId;
	public IntPtr DefaultHeapId;
	public uint ModuleId;
	public uint Threads;
	public uint ParentProcessId;
	public int PriClassBase;
	public uint Flags;
	[MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)]
	public string ExeFile;
}

[StructLayout(LayoutKind.Sequential)]
struct ActivationParams
{
	public int ActivationType;
	public uint TargetProcessId;
	public int LoopbackMode;
}

// a PROPVARIANT holding a blob
[StructLayout(LayoutKind.Sequential)]
struct BlobVariant
{
	public ushort Type;
	public ushort Reserved1;
	public ushort Reserved2;
	public ushort Reserved3;
	public int Size;
	public IntPtr Data;
}

[StructLayout(LayoutKind.Sequential, Pack = 2)]
struct WaveFormat
{
	public ushort FormatTag;
	public ushort Channels;
	public int SamplesPerSec;
	public int AvgBytesPerSec;
	public ushort BlockAlign;
	public ushort BitsPerSample;
	public ushort Size;
}

[ComImport, Guid("94EA2B94-E9CC-49E0-C0FF-EE64CA8F5B90"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAgileObject
{
}

[ComImport, Guid("41D949AB-9862-444A-80F6-C261334DA5EB"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IActivateAudioInterfaceCompletionHandler
{
	void ActivateCompleted(IActivateAudioInterfaceAsyncOperation operation);
}

[ComImport, Guid("72A22D78-CDE4-431D-B8CC-843A71199B6D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IActivateAudioInterfaceAsyncOperation
{
	void GetActivateResult(out int activateResult, [MarshalAs(UnmanagedType.IUnknown)] out object activatedInterface);
}

// the unused methods hold their place in the vtable
[ComImport, Guid("1CB9AD4C-DBFA-4C32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioClient
{
	[PreserveSig] int Initialize(int shareMode, uint streamFlags, long bufferDuration, long periodicity, ref WaveFormat format, IntPtr audioSessionGuid);
	void GetBufferSize();
	void GetStreamLatency();
	void GetCurrentPadding();
	void IsFormatSupported();
	void GetMixFormat();
	void GetDevicePeriod();
	[PreserveSig] int Start();
	[PreserveSig] int Stop();
	void Reset();
	[PreserveSig] int SetEventHandle(IntPtr eventHandle);
	[PreserveSig] int GetService(ref Guid iid, [MarshalAs(UnmanagedType.IUnknown)] out object service);
}

[ComImport, Guid("C8ADBD64-E71E-48A0-A4DE-185C395CD317"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioCaptureClient
{
	[PreserveSig] int GetBuffer(out IntPtr data, out uint frames, out uint flags, out ulong devicePosition, out ulong qpcPosition);
	[PreserveSig] int ReleaseBuffer(uint frames);
	[PreserveSig] int GetNextPacketSize(out uint frames);
}
