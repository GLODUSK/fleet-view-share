' Fleet View with no window: "fleet-view", the sign-in shortcut and the taskbar's right-click start this.
' It runs fleet-view.cmd's web loop in a hidden console (FLEET_VIEW_CHILD skips its own relaunch). With the
' desktop window installed that loop only hands over to the app, which runs the server hidden, and ends.
Set sh = CreateObject("WScript.Shell")
dir = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
args = ""
For Each a In WScript.Arguments
  args = args & " """ & a & """"
Next
sh.Environment("Process")("FLEET_VIEW_CHILD") = "1"
sh.Run "cmd /d /c """"" & dir & "\fleet-view.cmd""" & args & """", 0, False
