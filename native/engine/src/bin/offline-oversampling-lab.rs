#[path = "../offline_lab/mod.rs"]
mod offline_lab;

fn main() {
    if let Err(error) = offline_lab::run_cli() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
