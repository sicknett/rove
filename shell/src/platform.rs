//! Windows-specific pieces: the video window under the page, one running copy, and opening links.

use windows_sys::Win32::Foundation::{CloseHandle, ERROR_ALREADY_EXISTS, GetLastError, HANDLE, HWND, RECT};
use windows_sys::Win32::Graphics::Gdi::{BLACK_BRUSH, GetMonitorInfoW, GetStockObject, MONITOR_DEFAULTTONEAREST, MONITORINFO, MonitorFromWindow};
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::System::Threading::CreateMutexW;
use windows_sys::Win32::UI::Shell::ShellExecuteW;
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, FindWindowW, GWL_STYLE, GetClientRect, GetWindowLongPtrW, SetWindowLongPtrW, WS_CLIPCHILDREN, HWND_BOTTOM, IsIconic, MB_ICONERROR, MB_OK, MessageBoxW,
    RegisterClassW, SW_RESTORE, SW_SHOWNORMAL, SWP_NOACTIVATE, SetForegroundWindow, SetWindowPos, ShowWindow,
    WNDCLASSW, WS_CHILD, WS_CLIPSIBLINGS, WS_DISABLED, WS_VISIBLE,
};

/// The main window's class, which a second launch finds the first one by.
pub const WINDOW_CLASS: &str = "RoveDesktopWindow";

pub fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(Some(0)).collect()
}

/// Held for as long as the app runs.
pub struct SingleInstance(#[allow(dead_code)] HANDLE);

/// One copy at a time, since two cannot share the web view's profile. A second launch
/// brings the first window forward and gets None.
pub fn claim_instance(data_dir: &std::path::Path) -> Option<SingleInstance> {
    // One copy per data folder (two cannot share the web view's profile).
    let key = data_dir.to_string_lossy().to_lowercase();
    let hash = key.bytes().fold(0xcbf29ce484222325u64, |h, b| (h ^ u64::from(b)).wrapping_mul(0x100000001b3));
    let name = wide(&format!("Local\\RoveDesktop-{hash:016x}"));
    let handle = unsafe { CreateMutexW(std::ptr::null(), 0, name.as_ptr()) };
    if handle.is_null() || unsafe { GetLastError() } != ERROR_ALREADY_EXISTS {
        return Some(SingleInstance(handle));
    }
    unsafe {
        CloseHandle(handle);
        let window = FindWindowW(wide(WINDOW_CLASS).as_ptr(), std::ptr::null());
        if !window.is_null() {
            if IsIconic(window) != 0 {
                ShowWindow(window, SW_RESTORE);
            }
            SetForegroundWindow(window);
        }
    }
    None
}

pub fn open_external(url: &str) {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return;
    }
    let (op, file) = (wide("open"), wide(url));
    unsafe {
        ShellExecuteW(std::ptr::null_mut(), op.as_ptr(), file.as_ptr(), std::ptr::null(), std::ptr::null(), SW_SHOWNORMAL);
    }
}

pub fn open_folder(path: &std::path::Path) {
    let (op, file) = (wide("open"), wide(&path.display().to_string()));
    unsafe {
        ShellExecuteW(std::ptr::null_mut(), op.as_ptr(), file.as_ptr(), std::ptr::null(), std::ptr::null(), SW_SHOWNORMAL);
    }
}

/// Screen position of the mouse, and whether the left button is held.
pub fn mouse() -> ((i32, i32), bool) {
    use windows_sys::Win32::Foundation::POINT;
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON};
    use windows_sys::Win32::UI::WindowsAndMessaging::GetCursorPos;
    let mut p = POINT { x: 0, y: 0 };
    unsafe { GetCursorPos(&mut p) };
    let down = unsafe { GetAsyncKeyState(VK_LBUTTON as i32) } as u16 & 0x8000 != 0;
    ((p.x, p.y), down)
}

pub fn fatal(message: &str) -> ! {
    log::error!("{message}");
    let (text, title) = (wide(message), wide("ROVE"));
    unsafe { MessageBoxW(std::ptr::null_mut(), text.as_ptr(), title.as_ptr(), MB_OK | MB_ICONERROR) };
    std::process::exit(1)
}

/// The child window mpv draws into with Direct3D 11, kept beneath the transparent web view.
/// It is disabled so clicks always land on the page above it.
pub struct VideoSurface {
    hwnd: HWND,
}

unsafe extern "system" fn video_proc(hwnd: HWND, msg: u32, wparam: usize, lparam: isize) -> isize {
    unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) }
}

impl VideoSurface {
    pub fn new(parent: isize, width: u32, height: u32) -> Result<Self, String> {
        let class = wide("RoveVideoSurface");
        unsafe {
            let instance = GetModuleHandleW(std::ptr::null());
            let wc = WNDCLASSW {
                lpfnWndProc: Some(video_proc),
                hInstance: instance,
                lpszClassName: class.as_ptr(),
                hbrBackground: GetStockObject(BLACK_BRUSH),
                ..std::mem::zeroed()
            };
            RegisterClassW(&wc);
            let hwnd = CreateWindowExW(
                0,
                class.as_ptr(),
                std::ptr::null(),
                WS_CHILD | WS_VISIBLE | WS_CLIPSIBLINGS | WS_DISABLED,
                0,
                0,
                width as i32,
                height as i32,
                parent as HWND,
                std::ptr::null_mut(),
                instance,
                std::ptr::null(),
            );
            if hwnd.is_null() {
                return Err("could not create the video window".into());
            }
            Ok(Self { hwnd })
        }
    }

    pub fn id(&self) -> String {
        (self.hwnd as i64).to_string()
    }

    /// The video window's current size, as Windows has it.
    pub fn size(&self) -> (i32, i32) {
        let mut rect = RECT { left: 0, top: 0, right: 0, bottom: 0 };
        unsafe { GetClientRect(self.hwnd, &mut rect) };
        (rect.right - rect.left, rect.bottom - rect.top)
    }

    /// Hidden when nothing plays: then the page is opaque and nothing needs compositing beneath it.
    pub fn set_visible(&self, visible: bool) {
        use windows_sys::Win32::UI::WindowsAndMessaging::{SW_HIDE, SW_SHOWNA, ShowWindow};
        unsafe { ShowWindow(self.hwnd, if visible { SW_SHOWNA } else { SW_HIDE }) };
    }

    pub fn resize(&self, width: u32, height: u32) {
        unsafe { SetWindowPos(self.hwnd, HWND_BOTTOM, 0, 0, width as i32, height as i32, SWP_NOACTIVATE) };
    }
}

/// The usable area (screen minus taskbar) of the monitor the window is on, in physical pixels:
/// (left, top, right, bottom).
pub fn work_area(hwnd: isize) -> Option<(i32, i32, i32, i32)> {
    unsafe {
        let monitor = MonitorFromWindow(hwnd as HWND, MONITOR_DEFAULTTONEAREST);
        let mut info: MONITORINFO = std::mem::zeroed();
        info.cbSize = size_of::<MONITORINFO>() as u32;
        if GetMonitorInfoW(monitor, &mut info) == 0 {
            return None;
        }
        let r = info.rcWork;
        Some((r.left, r.top, r.right, r.bottom))
    }
}

/// Children (video, page) are left alone when the main window paints its background.
pub fn clip_children(hwnd: isize) {
    unsafe {
        let style = GetWindowLongPtrW(hwnd as HWND, GWL_STYLE);
        SetWindowLongPtrW(hwnd as HWND, GWL_STYLE, style | WS_CLIPCHILDREN as isize);
    }
}
