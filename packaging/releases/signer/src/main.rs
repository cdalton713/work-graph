//! Offline release tool. Read the PKCS#8 private key from stdin only.
use ed25519_dalek::{Signer, SigningKey, pkcs8::DecodePrivateKey};
use std::{
    env, fs,
    io::{self, Read, Write},
};
use zeroize::Zeroizing;

fn main() -> Result<(), &'static str> {
    let mut pem = Zeroizing::new(String::new());
    io::stdin()
        .read_to_string(&mut pem)
        .map_err(|_| "cannot read signing key")?;
    let signer =
        SigningKey::from_pkcs8_pem(pem.trim()).map_err(|_| "invalid Ed25519 signing key")?;
    let key = signer.verifying_key();
    let public = key
        .as_bytes()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>();
    let args: Vec<_> = env::args_os().skip(1).collect();
    match args.as_slice() {
        [flag] if flag == "--public-key" => println!("{public}"),
        [path] => {
            if env::var("WG_CURRENT_PUBLIC_KEY").as_deref() != Ok(public.as_str()) {
                return Err("signing key differs from the current public key");
            }
            let bytes = fs::read(path).map_err(|_| "cannot read manifest")?;
            let sig = signer.sign(&bytes);
            key.verify_strict(&bytes, &sig)
                .map_err(|_| "signature verification failed")?;
            io::stdout()
                .write_all(&sig.to_bytes())
                .map_err(|_| "cannot write signature")?;
        }
        _ => return Err("expected a manifest path or --public-key"),
    }
    Ok(())
}
