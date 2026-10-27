; Removes the "Start with Windows" entry the app adds, except when an update reinstalls the app
!macro customUnInstall
	${ifNot} ${isUpdated}
		DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "LOL Match Recorder"
	${endIf}
!macroend
