fn main() {
    println!("cargo:rerun-if-changed=icons/rove.ico");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        let mut res = winresource::WindowsResource::new();
        // Ordinal 1, which the window and taskbar icons are loaded from.
        res.set_icon_with_id("icons/rove.ico", "1");
        res.set("ProductName", "ROVE");
        res.set("FileDescription", "ROVE");
        if let Err(e) = res.compile() {
            println!("cargo:warning=could not embed the icon: {e}");
        }
    }
}
