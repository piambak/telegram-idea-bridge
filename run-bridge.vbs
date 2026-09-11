' Launch telegram bridge with no console window. Exit code passes through
' so Task Scheduler's restart-on-failure can revive it.
Dim sh, dir, code
Set sh = CreateObject("WScript.Shell")
dir = Left(WScript.ScriptFullName, InStrRev(WScript.ScriptFullName, "\") - 1)
sh.CurrentDirectory = dir
code = sh.Run("cmd /c node bridge.js >> bridge.log 2>> bridge.err.log", 0, True)
WScript.Quit(code)
