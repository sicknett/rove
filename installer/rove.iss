; ROVE installer (Inno Setup 6). Built by tools\make-installer.ps1, which passes:
;   /DAppVersion=<version> /DSourceDir=<dist\ROVE> /DOutputDir=<dist> /DImagesDir=<generated art> /DIconFile=<rove.ico>
; Installs for the current user only (no admin prompt). Profiles, history and sign-ins live in
; %LOCALAPPDATA%\ROVE and are kept on uninstall unless the user asks to remove them.

#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif

[Setup]
AppId={{6F8C5333-BE42-47F2-961E-5E075DC09F90}
AppName=ROVE
AppVersion={#AppVersion}
AppVerName=ROVE {#AppVersion}
AppPublisher=ROVE
VersionInfoVersion={#AppVersion}
VersionInfoProductName=ROVE
VersionInfoDescription=ROVE Setup
DefaultDirName={localappdata}\Programs\ROVE
DisableDirPage=auto
DefaultGroupName=ROVE
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0.17763
OutputDir={#OutputDir}
OutputBaseFilename=ROVE-Setup-{#AppVersion}
SetupIconFile={#IconFile}
UninstallDisplayIcon={app}\rove.exe
UninstallDisplayName=ROVE
WizardStyle=modern
WizardImageFile={#ImagesDir}\wizard-large.bmp
WizardSmallImageFile={#ImagesDir}\wizard-small.bmp
Compression=lzma2/ultra64
SolidCompression=yes
LZMANumBlockThreads=4
; A running ROVE is handled in [Code] (the app holds the RoveDesktopRunning mutex while open):
; an update started by the app itself waits for it to finish closing instead of giving up.
CloseApplications=yes
RestartApplications=no

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "Create a &desktop shortcut"; GroupDescription: "Shortcuts:"

[Files]
Source: "{#SourceDir}\rove.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#SourceDir}\libmpv-2.dll"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#SourceDir}\web\*"; DestDir: "{app}\web"; Flags: ignoreversion recursesubdirs createallsubdirs

[InstallDelete]
; The page's file names change every build; old ones must not pile up.
Type: filesandordirs; Name: "{app}\web"

[Icons]
Name: "{userprograms}\ROVE"; Filename: "{app}\rove.exe"; WorkingDir: "{app}"
Name: "{userdesktop}\ROVE"; Filename: "{app}\rove.exe"; WorkingDir: "{app}"; Tasks: desktopicon

[Run]
Filename: "{app}\rove.exe"; Description: "Open ROVE"; Flags: nowait postinstall skipifsilent
; An update the app started for itself: open ROVE again when the files are in place.
Filename: "{app}\rove.exe"; Flags: nowait; Check: IsSelfUpdate

[Code]
const
  WebView2Key = 'SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}';
  WebView2Download = 'https://go.microsoft.com/fwlink/p/?LinkId=2124703';

function HasWebView2: Boolean;
var
  Version: String;
begin
  Result :=
    (RegQueryStringValue(HKLM, 'SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}', 'pv', Version) and (Version <> '') and (Version <> '0.0.0.0')) or
    (RegQueryStringValue(HKLM, WebView2Key, 'pv', Version) and (Version <> '') and (Version <> '0.0.0.0')) or
    (RegQueryStringValue(HKCU, WebView2Key, 'pv', Version) and (Version <> '') and (Version <> '0.0.0.0'));
end;

function IsSelfUpdate: Boolean;
begin
  Result := ExpandConstant('{param:UPDATE|0}') = '1';
end;

{ False when ROVE is still open and its files cannot be replaced. }
function RoveClosed: Boolean;
var
  Waited: Integer;
begin
  Result := True;
  { The app starts this Setup as it closes: give it a moment to be gone. }
  if IsSelfUpdate then
  begin
    Waited := 0;
    while CheckForMutexes('RoveDesktopRunning') and (Waited < 30000) do
    begin
      Sleep(250);
      Waited := Waited + 250;
    end;
  end;
  while CheckForMutexes('RoveDesktopRunning') do
  begin
    if WizardSilent then
    begin
      Result := False;
      Exit;
    end;
    if MsgBox('ROVE is open. Close it, then choose OK to continue.', mbError, MB_OKCANCEL) <> IDOK then
    begin
      Result := False;
      Exit;
    end;
  end;
end;

function InitializeUninstall: Boolean;
begin
  Result := True;
  if CheckForMutexes('RoveDesktopRunning') then
  begin
    if not UninstallSilent then
      MsgBox('ROVE is open. Close it, then uninstall again.', mbError, MB_OK);
    Result := False;
  end;
end;

function InitializeSetup: Boolean;
var
  Code: Integer;
begin
  { An update the app started arrives with only the UPDATE marker (see shell\src\update.rs for
    why). It starts itself again without the wizard and steps aside. }
  if IsSelfUpdate and not WizardSilent then
  begin
    Exec(ExpandConstant('{srcexe}'), '/SILENT /SUPPRESSMSGBOXES /NORESTART /UPDATE=1', '', SW_SHOW, ewNoWait, Code);
    Result := False;
    Exit;
  end;
  Result := RoveClosed;
  if not Result then
    Exit;
  if not HasWebView2 then
  begin
    if MsgBox('ROVE needs Microsoft Edge WebView2, which this PC does not have yet.' + #13#10#13#10 +
              'Open Microsoft''s download page now? Install it, then run ROVE Setup again.',
              mbConfirmation, MB_YESNO) = IDYES then
      ShellExec('open', WebView2Download, '', '', SW_SHOWNORMAL, ewNoWait, Code);
    Result := False;
  end;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  DataDir: String;
begin
  if CurUninstallStep = usPostUninstall then
  begin
    DataDir := ExpandConstant('{localappdata}\ROVE');
    if DirExists(DataDir) and not UninstallSilent then
      if MsgBox('Also remove your ROVE profiles, history, addons and sign-ins from this PC?' + #13#10#13#10 +
                'Choose No to keep them for a later install.', mbConfirmation, MB_YESNO or MB_DEFBUTTON2) = IDYES then
        DelTree(DataDir, True, True, True);
  end;
end;
