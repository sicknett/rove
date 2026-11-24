//! Windows media controls (System Media Transport Controls): media keys, headset buttons and the
//! volume flyout show and control what ROVE is playing.

use windows::Foundation::{TypedEventHandler, Uri};
use windows::Media::{
    MediaPlaybackStatus, MediaPlaybackType, SystemMediaTransportControls, SystemMediaTransportControlsButton,
    SystemMediaTransportControlsButtonPressedEventArgs,
};
use windows::Storage::Streams::RandomAccessStreamReference;
use windows::Win32::Foundation::HWND;
use windows::Win32::System::WinRT::ISystemMediaTransportControlsInterop;
use windows::core::{HSTRING, factory};

pub struct MediaControls {
    smtc: SystemMediaTransportControls,
}

#[derive(serde::Deserialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct NowPlaying {
    pub state: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub subtitle: String,
    #[serde(default)]
    pub artwork: Option<String>,
    #[serde(default)]
    pub can_next: bool,
}

impl MediaControls {
    /// `on_key` gets "play", "pause", "toggle", "next", "previous" or "stop".
    pub fn new(hwnd: isize, on_key: impl Fn(&'static str) + Send + 'static) -> windows::core::Result<Self> {
        let interop = factory::<SystemMediaTransportControls, ISystemMediaTransportControlsInterop>()?;
        let smtc: SystemMediaTransportControls = unsafe { interop.GetForWindow(HWND(hwnd as _))? };
        smtc.SetIsEnabled(false)?;
        smtc.SetIsPlayEnabled(true)?;
        smtc.SetIsPauseEnabled(true)?;
        smtc.SetIsStopEnabled(true)?;
        smtc.ButtonPressed(&TypedEventHandler::<SystemMediaTransportControls, SystemMediaTransportControlsButtonPressedEventArgs>::new(
            move |_, args| {
                if let Some(args) = args.as_ref() {
                    let key = match args.Button()? {
                        SystemMediaTransportControlsButton::Play => "play",
                        SystemMediaTransportControlsButton::Pause => "pause",
                        SystemMediaTransportControlsButton::Next => "next",
                        SystemMediaTransportControlsButton::Previous => "previous",
                        SystemMediaTransportControlsButton::Stop => "stop",
                        _ => return Ok(()),
                    };
                    on_key(key);
                }
                Ok(())
            },
        ))?;
        Ok(Self { smtc })
    }

    pub fn update(&self, np: &NowPlaying) {
        if let Err(e) = self.try_update(np) {
            log::warn!("media controls: {e}");
        }
    }

    fn try_update(&self, np: &NowPlaying) -> windows::core::Result<()> {
        if np.state == "stopped" {
            self.smtc.SetPlaybackStatus(MediaPlaybackStatus::Stopped)?;
            self.smtc.DisplayUpdater()?.ClearAll()?;
            self.smtc.SetIsEnabled(false)?;
            return Ok(());
        }
        self.smtc.SetIsEnabled(true)?;
        self.smtc.SetIsNextEnabled(np.can_next)?;
        self.smtc.SetPlaybackStatus(if np.state == "playing" { MediaPlaybackStatus::Playing } else { MediaPlaybackStatus::Paused })?;
        let du = self.smtc.DisplayUpdater()?;
        du.SetType(MediaPlaybackType::Video)?;
        let video = du.VideoProperties()?;
        video.SetTitle(&HSTRING::from(&np.title))?;
        video.SetSubtitle(&HSTRING::from(&np.subtitle))?;
        if let Some(art) = np.artwork.as_deref().filter(|a| a.starts_with("https://")) {
            if let Ok(uri) = Uri::CreateUri(&HSTRING::from(art)) {
                du.SetThumbnail(&RandomAccessStreamReference::CreateFromUri(&uri)?)?;
            }
        }
        du.Update()
    }
}
