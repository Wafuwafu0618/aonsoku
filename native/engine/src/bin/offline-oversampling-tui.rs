use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use crossterm::event::{self, Event, KeyCode, KeyEventKind};
use crossterm::terminal::{
    disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen,
};
use crossterm::ExecutableCommand;
use ratatui::backend::CrosstermBackend;
use ratatui::layout::{Constraint, Direction, Layout};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, Clear, List, ListItem, Paragraph, Wrap};
use ratatui::Terminal;
use serde_json::Value;

#[path = "../offline_lab/mod.rs"]
mod offline_lab;

const TARGET_RATES: [u32; 3] = [96_000, 192_000, 384_000];
const FORCE_ENGINES: [&str; 4] = ["auto", "fft-ola", "short-fir-direct", "rubato-sinc"];
const PROJECT_ROOT_WINDOWS: &str = r"C:\aonsoku";
const PROJECT_ROOT_WSL: &str = "/mnt/c/aonsoku";
const DEFAULT_SOURCE_FILE: &str = "song.mp3";

#[derive(Debug, Clone)]
struct FilterItem {
    token: String,
    enabled: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Focus {
    Main,
    Filters,
}

#[derive(Debug)]
struct App {
    should_quit: bool,
    focus: Focus,
    main_index: usize,
    filter_index: usize,
    source_candidates: Vec<String>,
    source_index: usize,
    output_dir: String,
    target_rate_index: usize,
    force_engine_index: usize,
    analyze_impulse: bool,
    write_impulse_wav: bool,
    self_null: bool,
    filters: Vec<FilterItem>,
    status: String,
    summary_lines: Vec<String>,
}

impl App {
    fn new() -> Self {
        let default_source = default_source_path();
        let source_candidates = discover_sources();
        let source_index = source_candidates
            .iter()
            .position(|source| source == &default_source)
            .unwrap_or(0);
        Self {
            should_quit: false,
            focus: Focus::Main,
            main_index: 0,
            filter_index: 0,
            source_candidates,
            source_index,
            output_dir: new_output_dir(),
            target_rate_index: 2,
            force_engine_index: 0,
            analyze_impulse: true,
            write_impulse_wav: false,
            self_null: true,
            filters: vec![
                FilterItem {
                    token: "sinc-ultra".to_string(),
                    enabled: true,
                },
                FilterItem {
                    token: "sinc-ultra-apod".to_string(),
                    enabled: true,
                },
                FilterItem {
                    token: "sinc-mega".to_string(),
                    enabled: true,
                },
                FilterItem {
                    token: "sinc-mega-apod".to_string(),
                    enabled: true,
                },
                FilterItem {
                    token: "sinc-l-lp".to_string(),
                    enabled: false,
                },
            ],
            status: "Ready".to_string(),
            summary_lines: vec![
                "Use arrow keys + Enter/Space".to_string(),
                "Press Enter on Run to execute".to_string(),
            ],
        }
    }

    fn selected_filters(&self) -> Vec<String> {
        self.filters
            .iter()
            .filter(|item| item.enabled)
            .map(|item| item.token.clone())
            .collect()
    }

    fn current_source(&self) -> &str {
        self.source_candidates
            .get(self.source_index)
            .map(String::as_str)
            .unwrap_or(DEFAULT_SOURCE_FILE)
    }
}

fn discover_sources() -> Vec<String> {
    let fixtures_dir = fixtures_dir_path();
    let mut candidates = Vec::<String>::new();
    if let Ok(entries) = fs::read_dir(&fixtures_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            let Some(ext) = path.extension().and_then(|ext| ext.to_str()) else {
                continue;
            };
            let normalized = ext.to_ascii_lowercase();
            if !matches!(
                normalized.as_str(),
                "mp3" | "flac" | "wav" | "aac" | "m4a" | "ogg"
            ) {
                continue;
            }
            candidates.push(path.to_string_lossy().to_string());
        }
    }
    candidates.sort();
    let default_source = default_source_path();
    if !candidates.iter().any(|candidate| candidate == &default_source) {
        candidates.insert(0, default_source);
    }
    if candidates.is_empty() {
        candidates.push(default_source_path());
    }
    candidates
}

fn resolve_project_root() -> PathBuf {
    let win = Path::new(PROJECT_ROOT_WINDOWS);
    let wsl = Path::new(PROJECT_ROOT_WSL);
    if cfg!(target_os = "windows") {
        if win.exists() {
            return win.to_path_buf();
        }
        if wsl.exists() {
            return wsl.to_path_buf();
        }
        return win.to_path_buf();
    }
    if wsl.exists() {
        return wsl.to_path_buf();
    }
    if win.exists() {
        return win.to_path_buf();
    }
    wsl.to_path_buf()
}

fn fixtures_dir_path() -> PathBuf {
    resolve_project_root().join("cypress").join("fixtures")
}

fn default_source_path() -> String {
    fixtures_dir_path()
        .join(DEFAULT_SOURCE_FILE)
        .to_string_lossy()
        .to_string()
}

fn new_output_dir() -> String {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0);
    resolve_project_root()
        .join("native")
        .join("engine")
        .join(format!("offline-lab-tui-{stamp}"))
        .to_string_lossy()
        .to_string()
}

fn main() {
    if let Err(error) = run_tui() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}

fn run_tui() -> Result<(), String> {
    enable_raw_mode().map_err(|error| format!("Failed to enable raw mode: {error}"))?;
    let mut stdout = std::io::stdout();
    stdout
        .execute(EnterAlternateScreen)
        .map_err(|error| format!("Failed to enter alternate screen: {error}"))?;
    let backend = CrosstermBackend::new(stdout);
    let mut terminal =
        Terminal::new(backend).map_err(|error| format!("Failed to create terminal: {error}"))?;

    let result = run_event_loop(&mut terminal);

    disable_raw_mode().map_err(|error| format!("Failed to disable raw mode: {error}"))?;
    terminal
        .backend_mut()
        .execute(LeaveAlternateScreen)
        .map_err(|error| format!("Failed to leave alternate screen: {error}"))?;
    terminal
        .show_cursor()
        .map_err(|error| format!("Failed to restore cursor: {error}"))?;

    result
}

fn run_event_loop(
    terminal: &mut Terminal<CrosstermBackend<std::io::Stdout>>,
) -> Result<(), String> {
    let mut app = App::new();

    while !app.should_quit {
        terminal
            .draw(|frame| render(frame, &app))
            .map_err(|error| format!("Failed to draw TUI: {error}"))?;

        if event::poll(std::time::Duration::from_millis(100))
            .map_err(|error| format!("Event poll failed: {error}"))?
        {
            let evt = event::read().map_err(|error| format!("Event read failed: {error}"))?;
            if let Event::Key(key) = evt {
                if key.kind != KeyEventKind::Press {
                    continue;
                }
                handle_key(&mut app, key.code)?;
            }
        }
    }

    Ok(())
}

fn handle_key(app: &mut App, code: KeyCode) -> Result<(), String> {
    match app.focus {
        Focus::Main => handle_main_key(app, code),
        Focus::Filters => {
            handle_filter_key(app, code);
            Ok(())
        }
    }
}

fn handle_main_key(app: &mut App, code: KeyCode) -> Result<(), String> {
    const MAIN_ITEMS: usize = 10;
    match code {
        KeyCode::Char('q') | KeyCode::Esc => {
            app.should_quit = true;
        }
        KeyCode::Up => {
            if app.main_index == 0 {
                app.main_index = MAIN_ITEMS - 1;
            } else {
                app.main_index -= 1;
            }
        }
        KeyCode::Down => {
            app.main_index = (app.main_index + 1) % MAIN_ITEMS;
        }
        KeyCode::Enter => match app.main_index {
            0 => {
                app.source_index = (app.source_index + 1) % app.source_candidates.len();
            }
            1 => {
                app.output_dir = new_output_dir();
            }
            2 => {
                app.target_rate_index = (app.target_rate_index + 1) % TARGET_RATES.len();
            }
            3 => {
                app.force_engine_index = (app.force_engine_index + 1) % FORCE_ENGINES.len();
            }
            4 => {
                app.analyze_impulse = !app.analyze_impulse;
                if !app.analyze_impulse {
                    app.write_impulse_wav = false;
                }
            }
            5 => {
                if app.analyze_impulse {
                    app.write_impulse_wav = !app.write_impulse_wav;
                }
            }
            6 => {
                app.self_null = !app.self_null;
            }
            7 => {
                app.focus = Focus::Filters;
            }
            8 => {
                run_lab(app)?;
            }
            9 => {
                app.should_quit = true;
            }
            _ => {}
        },
        _ => {}
    }
    Ok(())
}

fn handle_filter_key(app: &mut App, code: KeyCode) {
    let len = app.filters.len().max(1);
    match code {
        KeyCode::Esc | KeyCode::Enter => {
            app.focus = Focus::Main;
        }
        KeyCode::Up => {
            if app.filter_index == 0 {
                app.filter_index = len - 1;
            } else {
                app.filter_index -= 1;
            }
        }
        KeyCode::Down => {
            app.filter_index = (app.filter_index + 1) % len;
        }
        KeyCode::Char(' ') => {
            if let Some(item) = app.filters.get_mut(app.filter_index) {
                item.enabled = !item.enabled;
            }
        }
        KeyCode::Char('a') => {
            for item in &mut app.filters {
                item.enabled = true;
            }
        }
        KeyCode::Char('n') => {
            for item in &mut app.filters {
                item.enabled = false;
            }
        }
        _ => {}
    }
}

fn run_lab(app: &mut App) -> Result<(), String> {
    let selected = app.selected_filters();
    if selected.is_empty() {
        app.status = "Select at least one filter".to_string();
        return Ok(());
    }

    app.status = "Running offline-oversampling-lab...".to_string();
    app.summary_lines.clear();

    let reference = selected[0].clone();
    let mut tokens = vec![
        "--src".to_string(),
        app.current_source().to_string(),
        "--filters".to_string(),
        selected.join(","),
        "--reference-filter".to_string(),
        reference,
        "--target-sample-rate".to_string(),
        TARGET_RATES[app.target_rate_index].to_string(),
        "--output-dir".to_string(),
        app.output_dir.clone(),
        "--force-engine".to_string(),
        FORCE_ENGINES[app.force_engine_index].to_string(),
        "--stopband-start-hz".to_string(),
        "22050".to_string(),
    ];
    if app.self_null {
        tokens.push("--self-null".to_string());
    }
    if app.analyze_impulse {
        tokens.push("--analyze-impulse".to_string());
        tokens.push("--impulse-frames".to_string());
        tokens.push("131072".to_string());
        tokens.push("--write-impulse-plot".to_string());
    }
    if app.write_impulse_wav {
        tokens.push("--write-impulse-wav".to_string());
    }

    match offline_lab::run_from_tokens(&tokens) {
        Ok(report_json) => {
            app.status = format!("Completed: {}", app.output_dir);
            app.summary_lines = summarize_report(&report_json);
        }
        Err(error) => {
            app.status = format!("Failed: {error}");
            app.summary_lines = vec!["Run failed. Check configuration.".to_string()];
        }
    }

    Ok(())
}

fn summarize_report(report_json: &str) -> Vec<String> {
    let parsed: Value = match serde_json::from_str(report_json) {
        Ok(value) => value,
        Err(error) => {
            return vec![format!("JSON parse failed: {error}")];
        }
    };

    let mut lines = Vec::<String>::new();
    if let Some(cases) = parsed.get("cases").and_then(Value::as_array) {
        lines.push("Cases".to_string());
        for item in cases {
            let token = item.get("filterToken").and_then(Value::as_str).unwrap_or("unknown");
            let peak = item.get("peakDbfs").and_then(Value::as_f64).unwrap_or(f64::NAN);
            let clip = item.get("clipRatio").and_then(Value::as_f64).unwrap_or(f64::NAN);
            let ms = item
                .get("processingTimeMs")
                .and_then(Value::as_f64)
                .unwrap_or(f64::NAN);
            lines.push(format!(
                "  {token}: processing={ms:.2}ms peak={peak:.3}dBFS clipRatio={clip:.8}"
            ));
        }
    }

    if let Some(impulse) = parsed.get("impulseAnalyses").and_then(Value::as_array) {
        lines.push("Impulse".to_string());
        for item in impulse {
            let token = item.get("filterToken").and_then(Value::as_str).unwrap_or("unknown");
            let attn = item
                .get("stopbandAttenuationDb")
                .and_then(Value::as_f64)
                .unwrap_or(f64::NAN);
            let p95 = item
                .get("stopbandP95AttenuationDb")
                .and_then(Value::as_f64)
                .unwrap_or(f64::NAN);
            lines.push(format!("  {token}: stopbandAttn={attn:.2} dB, p95={p95:.2} dB"));
            if let Some(plot_path) = item.get("impulsePlotPath").and_then(Value::as_str) {
                lines.push(format!("    plot={plot_path}"));
            }
        }
    }

    if lines.is_empty() {
        lines.push("No summary available.".to_string());
    }
    lines
}

fn render(frame: &mut ratatui::Frame, app: &App) {
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Length(14), Constraint::Min(8), Constraint::Length(3)])
        .split(frame.area());

    let selected_count = app.filters.iter().filter(|item| item.enabled).count();
    let main_rows = vec![
        format!("Source: {}", app.current_source()),
        format!("Output Dir: {}", app.output_dir),
        format!("Target Sample Rate: {} Hz", TARGET_RATES[app.target_rate_index]),
        format!("Force Engine: {}", FORCE_ENGINES[app.force_engine_index]),
        format!("Analyze Impulse: {}", on_off(app.analyze_impulse)),
        format!("Write Impulse WAV: {}", on_off(app.write_impulse_wav)),
        format!("Self Null: {}", on_off(app.self_null)),
        format!("Filters: {selected_count}/{}", app.filters.len()),
        "Run".to_string(),
        "Quit".to_string(),
    ];
    let main_items = main_rows
        .iter()
        .enumerate()
        .map(|(index, row)| {
            let focused = app.focus == Focus::Main && app.main_index == index;
            let style = if focused {
                Style::default()
                    .fg(Color::Black)
                    .bg(Color::Cyan)
                    .add_modifier(Modifier::BOLD)
            } else {
                Style::default()
            };
            ListItem::new(Line::from(vec![Span::raw(row)]))
                .style(style)
        })
        .collect::<Vec<_>>();
    let main = List::new(main_items)
        .block(Block::default().borders(Borders::ALL).title("Offline Oversampling Lab TUI"));
    frame.render_widget(main, chunks[0]);

    let summary_text = app.summary_lines.join("\n");
    let summary = Paragraph::new(summary_text)
        .block(Block::default().borders(Borders::ALL).title("Summary"))
        .wrap(Wrap { trim: false });
    frame.render_widget(summary, chunks[1]);

    let help = Paragraph::new(
        "Main: Up/Down, Enter | Filters: Up/Down, Space toggle, a all, n none, Enter/Esc back | q quit",
    )
    .block(
        Block::default()
            .borders(Borders::ALL)
            .title(format!("Status: {}", app.status)),
    );
    frame.render_widget(help, chunks[2]);

    if app.focus == Focus::Filters {
        let area = centered_rect(70, 70, frame.area());
        frame.render_widget(Clear, area);
        let filter_items = app
            .filters
            .iter()
            .enumerate()
            .map(|(index, item)| {
                let marker = if item.enabled { "[x]" } else { "[ ]" };
                let row = format!("{marker} {}", item.token);
                let focused = app.filter_index == index;
                let style = if focused {
                    Style::default()
                        .fg(Color::Black)
                        .bg(Color::Yellow)
                        .add_modifier(Modifier::BOLD)
                } else {
                    Style::default()
                };
                ListItem::new(row).style(style)
            })
            .collect::<Vec<_>>();
        let popup = List::new(filter_items).block(
            Block::default()
                .title("Filter Selection (Space toggle, Enter/Esc close)")
                .borders(Borders::ALL),
        );
        frame.render_widget(popup, area);
    }
}

fn centered_rect(percent_x: u16, percent_y: u16, area: ratatui::layout::Rect) -> ratatui::layout::Rect {
    let popup_layout = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Percentage((100 - percent_y) / 2),
            Constraint::Percentage(percent_y),
            Constraint::Percentage((100 - percent_y) / 2),
        ])
        .split(area);
    Layout::default()
        .direction(Direction::Horizontal)
        .constraints([
            Constraint::Percentage((100 - percent_x) / 2),
            Constraint::Percentage(percent_x),
            Constraint::Percentage((100 - percent_x) / 2),
        ])
        .split(popup_layout[1])[1]
}

fn on_off(flag: bool) -> &'static str {
    if flag {
        "ON"
    } else {
        "OFF"
    }
}
