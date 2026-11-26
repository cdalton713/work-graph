fn main() {
    let target = std::env::var("TARGET").expect("Cargo sets TARGET for build scripts");
    println!("cargo::rustc-env=WG_BUILD_TARGET={target}");
    println!("cargo::rerun-if-changed=build.rs");
}
