' Fleet View with no window: "fleet-view", the sign-in shortcut and the taskbar's right-click start this.
' It runs fleet-view.cmd's web loop in a hidden console (FLEET_VIEW_CHILD skips its own relaunch). With the
' desktop window installed that loop only hands over to the app, which runs the server hidden, and ends.
Set sh = CreateObject("WScript.Shell")
dir = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
' Fleet View runs on Node.js: without node on this PATH the hidden console would fail with nothing on screen
If sh.Run("cmd /d /c where node >nul 2>nul", 0, True) <> 0 Then
  MsgBox "Fleet View needs Node.js 18 or newer, and node was not found." & vbCrLf & vbCrLf & _
    "Install it (winget install OpenJS.NodeJS.LTS, or from nodejs.org), then start Fleet View again. " & _
    "If it still says this, sign out of Windows and back in.", vbExclamation, "Fleet View"
  WScript.Quit 1
End If
args = ""
For Each a In WScript.Arguments
  args = args & " """ & a & """"
Next
' Start in our own folder: the window and server keep their start folder open, so starting from a worktree
' would lock that worktree until they exit.
sh.CurrentDirectory = dir
sh.Environment("Process")("FLEET_VIEW_CHILD") = "1"
sh.Run "cmd /d /c """"" & dir & "\fleet-view.cmd""" & args & """", 0, False
