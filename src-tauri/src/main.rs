#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use std::process::Command;
use std::fs;
use std::io::Write;
use tauri::{Manager};
use tauri_plugin_dialog::DialogExt;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

#[derive(Serialize, Deserialize)]
struct Remote {
    name: String,
    r#type: String,  // Using r#type to avoid Rust keyword collision
    mounted: String,
    cron: String,
    mount_point: String,
}

#[derive(Serialize)]
struct CommandResult {
    success: bool,
    message: String,
}

// Plugin structure definition
#[derive(Serialize, Deserialize, Clone)]
struct PluginField {
    name: String,
    display_name: String,
    #[serde(rename = "type")]
    field_type: String,
    required: bool,
    #[serde(default)]
    default: String,
    #[serde(default)]
    placeholder: String,
}

#[derive(Serialize, Deserialize)]
struct Plugin {
    name: String,
    display_name: String,
    description: String,
    version: String,
    author: String,
    fields: Vec<PluginField>,
    #[serde(default)]
    validation: HashMap<String, serde_json::Value>,
}

// Get all rclone remotes
#[tauri::command]
async fn get_remotes(config_path_opt: Option<String>) -> Result<Vec<Remote>, String> {
    // Use the provided config path or default to ~/.config/rclone/rclone.conf
    let config_path = if let Some(path_str) = config_path_opt {
        expand_tilde_path(&path_str)?
    } else {
        // Use the default path
        let home_dir = std::env::var("HOME").map_err(|e| format!("HOME not set: {}", e))?;
        std::path::PathBuf::from(&home_dir).join(".config").join("rclone").join("rclone.conf")
    };

    println!("Looking for config at path: {:?}", config_path); // Debug log

    if !config_path.exists() {
        return Err(format!("rclone.conf not found at {:?}", config_path));
    }

    // Read the config file to get remote names and types
    let config_content = fs::read_to_string(&config_path)
        .map_err(|e| format!("Failed to read config from {:?}: {}", config_path, e))?;

    println!("Config file content length: {}", config_content.len());

    let mut remotes = Vec::new();
    let mut current_section = String::new();
    let mut current_type = String::new();

    for (_, line) in config_content.lines().enumerate() {
        let line = line.trim();

        // Skip empty lines and comments
        if line.is_empty() || line.starts_with('#') || line.starts_with(';') {
            continue;
        }

        // Check if this is a section header
        if line.starts_with('[') && line.ends_with(']') {
            // If we have a previous section with a type, add it to the list
            if !current_section.is_empty() && !current_type.is_empty() {
                let mount_point = get_mount_dir(&current_section);
                let mounted = if is_mounted(&mount_point) { "Yes".to_string() } else { "No".to_string() };
                let cron = if is_in_crontab(&current_section) { "Yes".to_string() } else { "No".to_string() };

                println!("Adding remote: {} of type {}", current_section, current_type);

                remotes.push(Remote {
                    name: current_section,
                    r#type: current_type,
                    mounted,
                    cron,
                    mount_point,
                });
            }

            // Start processing new section
            current_section = line[1..line.len()-1].to_string();
            current_type = String::new();
        } else if line.starts_with("type =") || line.starts_with("type=") {
            // Extract the type value
            let parts: Vec<&str> = line.splitn(2, '=').collect();
            if parts.len() > 1 {
                current_type = parts[1].trim().to_string();
                println!("Found type '{}' for section '{}'", current_type, current_section);
            }
        }
    }

    // Add the last section if it was a remote
    if !current_section.is_empty() && !current_type.is_empty() {
        let mount_point = get_mount_dir(&current_section);
        let mounted = if is_mounted(&mount_point) { "Yes".to_string() } else { "No".to_string() };
        let cron = if is_in_crontab(&current_section) { "Yes".to_string() } else { "No".to_string() };

        println!("Adding final remote: {} of type {}", current_section, current_type);

        remotes.push(Remote {
            name: current_section,
            r#type: current_type,
            mounted,
            cron,
            mount_point,
        });
    }

    println!("Found {} remotes total", remotes.len());
    Ok(remotes)
}

// Mount a remote
#[tauri::command]
async fn mount_remote(remote_name: String, config_path_opt: Option<String>) -> Result<CommandResult, String> {
    let mount_point = get_mount_dir(&remote_name);

    // Check if already mounted
    if is_mounted(&mount_point) {
        return Ok(CommandResult {
            success: true,
            message: format!("{} is already mounted at {}", remote_name, mount_point),
        });
    }

    // Create mount directory if it doesn't exist
    std::fs::create_dir_all(&mount_point)
        .map_err(|e| format!("Failed to create mount directory: {}", e))?;

    // Execute rclone mount command
    let mut cmd = Command::new("rclone");
    cmd.args(&[
        "mount",
        &format!("{}:", remote_name),
        &mount_point,
        "--vfs-cache-mode",
        "writes",
        "--daemon",  // Run in background
    ]);

    if let Some(config_path_str) = config_path_opt {
        let expanded_config_path = expand_tilde_path(&config_path_str)?;
        cmd.arg("--config").arg(expanded_config_path);
    }

    let output = cmd.output()
        .map_err(|e| format!("Failed to execute rclone mount: {}", e))?;

    if output.status.success() {
        Ok(CommandResult {
            success: true,
            message: format!("Successfully mounted {} at {}", remote_name, mount_point),
        })
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(format!("Mount failed: {}", stderr))
    }
}

// Unmount a remote
#[tauri::command]
async fn unmount_remote(remote_name: String, _config_path_opt: Option<String>) -> Result<CommandResult, String> {
    let mount_point = get_mount_dir(&remote_name);

    if !is_mounted(&mount_point) {
        return Ok(CommandResult {
            success: true,
            message: format!("{} is not mounted", remote_name),
        });
    }

    // Try fusermount first (Linux) - this doesn't need config file
    let output = Command::new("fusermount")
        .args(&["-u", &mount_point])
        .output();

    match output {
        Ok(output) if output.status.success() => {
            Ok(CommandResult {
                success: true,
                message: format!("Successfully unmounted {}", remote_name),
            })
        }
        _ => {
            // Try umount as fallback - this also doesn't need config file
            let output = Command::new("umount")
                .arg(&mount_point)
                .output()
                .map_err(|e| format!("Failed to execute unmount command: {}", e))?;

            if output.status.success() {
                Ok(CommandResult {
                    success: true,
                    message: format!("Successfully unmounted {}", remote_name),
                })
            } else {
                let stderr = String::from_utf8_lossy(&output.stderr);
                Err(format!("Unmount failed: {}", stderr))
            }
        }
    }
}

// Test connection to a remote
#[tauri::command]
async fn test_connection(remote_name: String, config_path_opt: Option<String>) -> Result<CommandResult, String> {
    let mut cmd = Command::new("rclone");
    cmd.arg("lsf").arg(&format!("{}:", remote_name));

    if let Some(config_path_str) = config_path_opt {
        let expanded_config_path = expand_tilde_path(&config_path_str)?;
        cmd.arg("--config").arg(expanded_config_path);
    }

    let output = cmd.output()
        .map_err(|e| format!("Failed to execute rclone test: {}", e))?;

    if output.status.success() {
        Ok(CommandResult {
            success: true,
            message: format!("Connection to {} successful", remote_name),
        })
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(format!("Connection test failed: {}", stderr))
    }
}

// Open a folder in the system file manager
#[tauri::command]
async fn open_folder(path: String) -> Result<CommandResult, String> {
    #[cfg(target_os = "linux")]
    {
        Command::new("xdg-open")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("Failed to open folder: {}", e))?;
    }

    #[cfg(target_os = "windows")]
    {
        Command::new("explorer")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("Failed to open folder: {}", e))?;
    }

    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("Failed to open folder: {}", e))?;
    }

    Ok(CommandResult {
        success: true,
        message: format!("Opened folder: {}", path),
    })
}

// Helper function to get mount directory
fn get_mount_dir(remote_name: &str) -> String {
    let home_dir = std::env::var("HOME").expect("HOME environment variable not set");
    format!("{}/mnt/{}", home_dir, remote_name)
}

// Helper function to check if directory is mounted
fn is_mounted(mount_point: &str) -> bool {
    Command::new("mountpoint")
        .arg("-q")
        .arg(mount_point)
        .status()
        .map(|status| status.success())
        .unwrap_or_else(|_| {
            // If mountpoint command is not available, check with Path::is_mounted (if available)
            std::path::Path::new(mount_point).is_dir()
        })
}

// Add cron entry for a remote
#[tauri::command]
async fn add_to_cron(remote_name: String) -> Result<CommandResult, String> {
    // Get current crontab
    let output = Command::new("crontab")
        .arg("-l")
        .output();

    let current_cron = match output {
        Ok(output) if output.status.success() => {
            String::from_utf8_lossy(&output.stdout).to_string()
        }
        Ok(_) => String::new(), // Empty crontab
        Err(e) => return Err(format!("Failed to read crontab: {}", e)),
    };

    // Check if entry already exists
    let mount_cmd = format!("rclone mount --vfs-cache-mode writes {}:", remote_name);
    if current_cron.contains(&mount_cmd) {
        return Ok(CommandResult {
            success: true,
            message: format!("Remote {} is already scheduled for auto-mount", remote_name),
        });
    }

    // Add new entry
    let mount_point = get_mount_dir(&remote_name);
    let new_entry = format!("@reboot {} {}\n", mount_cmd, mount_point);
    let new_cron = format!("{}{}", current_cron, new_entry);

    // Write to crontab
    let mut child = Command::new("crontab")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to spawn crontab: {}", e))?;

    let stdin = child.stdin.as_mut().unwrap();
    stdin.write_all(new_cron.as_bytes())
        .map_err(|e| format!("Failed to write to crontab: {}", e))?;

    let output = child.wait_with_output()
        .map_err(|e| format!("Failed to wait for crontab: {}", e))?;

    if output.status.success() {
        Ok(CommandResult {
            success: true,
            message: format!("Added {} to crontab for auto-mount", remote_name),
        })
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(format!("Failed to add to crontab: {}", stderr))
    }
}

// Remove cron entry for a remote
#[tauri::command]
async fn remove_from_cron(remote_name: String) -> Result<CommandResult, String> {
    // Get current crontab
    let output = Command::new("crontab")
        .arg("-l")
        .output();

    let current_cron = match output {
        Ok(output) if output.status.success() => {
            String::from_utf8_lossy(&output.stdout).to_string()
        }
        Ok(_) => return Ok(CommandResult {
            success: true,
            message: "No crontab entries found".to_string(),
        }), // Empty crontab
        Err(e) => return Err(format!("Failed to read crontab: {}", e)),
    };

    if current_cron.trim().is_empty() {
        return Ok(CommandResult {
            success: true,
            message: "No crontab entries found".to_string(),
        });
    }

    let mount_cmd = format!("rclone mount --vfs-cache-mode writes {}:", remote_name);

    // Filter out entries with this remote
    let lines: Vec<&str> = current_cron.lines().collect();
    let new_lines: Vec<&str> = lines.into_iter()
        .filter(|line| !line.contains(&mount_cmd))
        .collect();
    let new_cron = new_lines.join("\n") + "\n";

    // Write to crontab
    let mut child = Command::new("crontab")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to spawn crontab: {}", e))?;

    let stdin = child.stdin.as_mut().unwrap();
    stdin.write_all(new_cron.as_bytes())
        .map_err(|e| format!("Failed to write to crontab: {}", e))?;

    let output = child.wait_with_output()
        .map_err(|e| format!("Failed to wait for crontab: {}", e))?;

    if output.status.success() {
        Ok(CommandResult {
            success: true,
            message: format!("Removed {} from crontab", remote_name),
        })
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(format!("Failed to remove from crontab: {}", stderr))
    }
}

// Check if remote is in crontab
#[tauri::command]
async fn is_remote_in_cron(remote_name: String) -> Result<bool, String> {
    let output = Command::new("crontab")
        .arg("-l")
        .output();

    match output {
        Ok(output) if output.status.success() => {
            let crontab_content = String::from_utf8_lossy(&output.stdout);
            let mount_cmd = format!("rclone mount --vfs-cache-mode writes {}:", remote_name);
            Ok(crontab_content.contains(&mount_cmd))
        }
        Ok(_) => Ok(false), // Empty crontab
        Err(e) => Err(format!("Failed to read crontab: {}", e)),
    }
}

// Helper function to check if remote is in crontab
fn is_in_crontab(remote_name: &str) -> bool {
    let output = Command::new("crontab")
        .arg("-l")
        .output();

    match output {
        Ok(output) if output.status.success() => {
            let crontab_content = String::from_utf8_lossy(&output.stdout);
            let mount_cmd = format!("rclone mount --vfs-cache-mode writes {}:", remote_name);
            crontab_content.contains(&mount_cmd)
        }
        _ => false,
    }
}

// Helper function to expand tilde paths
fn expand_tilde_path(path_str: &str) -> Result<PathBuf, String> {
    let path = Path::new(path_str);

    if path.starts_with("~") {
        let home_dir = std::env::var("HOME").map_err(|e| format!("HOME not set: {}", e))?;
        let expanded_path = path_str.replacen("~", &home_dir, 1);
        Ok(PathBuf::from(expanded_path))
    } else {
        Ok(PathBuf::from(path_str))
    }
}

// Check if rclone is installed
#[tauri::command]
async fn is_rclone_installed() -> Result<bool, String> {
    let output = Command::new("rclone")
        .arg("--version")
        .output();

    match output {
        Ok(output) => Ok(output.status.success()),
        Err(_) => Ok(false), // Command not found
    }
}

// Get available plugins
#[tauri::command]
async fn get_available_plugins() -> Result<Vec<Plugin>, String> {
    let plugins_dir = std::env::current_dir()
        .map_err(|e| format!("Failed to get current directory: {}", e))?
        .join("plugins");

    if !plugins_dir.exists() {
        return Ok(Vec::new());
    }

    let mut plugins = Vec::new();
    for entry in std::fs::read_dir(&plugins_dir)
        .map_err(|e| format!("Failed to read plugins directory: {}", e))?
    {
        let entry = entry.map_err(|e| format!("Failed to read directory entry: {}", e))?;
        let path = entry.path();

        if path.is_dir() {
            let config_path = path.join("config.json");
            if config_path.exists() {
                let config_content = std::fs::read_to_string(&config_path)
                    .map_err(|e| format!("Failed to read plugin config: {}", e))?;

                let plugin: Plugin = serde_json::from_str(&config_content)
                    .map_err(|e| format!("Failed to parse plugin config: {}", e))?;

                plugins.push(plugin);
            }
        }
    }

    Ok(plugins)
}

// Add a new remote using a plugin
#[tauri::command]
async fn add_remote_with_plugin(plugin_name: String, config: std::collections::HashMap<String, String>, config_path_opt: Option<String>) -> Result<CommandResult, String> {
    // Get the plugin configuration
    let plugins_dir = std::env::current_dir()
        .map_err(|e| format!("Failed to get current directory: {}", e))?
        .join("plugins")
        .join(&plugin_name);

    let config_path_file = plugins_dir.join("config.json");
    if !config_path_file.exists() {
        return Err(format!("Plugin {} not found", plugin_name));
    }

    let config_content = std::fs::read_to_string(&config_path_file)
        .map_err(|e| format!("Failed to read plugin config: {}", e))?;

    let plugin: Plugin = serde_json::from_str(&config_content)
        .map_err(|e| format!("Failed to parse plugin config: {}", e))?;

    // Validate the provided configuration against the plugin schema
    for field in &plugin.fields {
        if field.required && !config.contains_key(&field.name) {
            return Err(format!("Required field '{}' is missing", field.name));
        }

        if let Some(value) = config.get(&field.name) {
            // Basic validation based on field type
            match field.field_type.as_str() {
                "number" => {
                    if value.parse::<f64>().is_err() {
                        return Err(format!("Field '{}' must be a number", field.name));
                    }
                },
                "checkbox" => {
                    if value != "true" && value != "false" {
                        return Err(format!("Field '{}' must be true or false", field.name));
                    }
                },
                _ => {} // Other types don't need specific validation here
            }
        }
    }

    // Use the provided config path or default to ~/.config/rclone/rclone.conf
    let config_path = if let Some(path_str) = config_path_opt {
        expand_tilde_path(&path_str)?
    } else {
        // Use the default path
        let home_dir = std::env::var("HOME").map_err(|e| format!("HOME not set: {}", e))?;
        std::path::PathBuf::from(&home_dir).join(".config").join("rclone").join("rclone.conf")
    };

    // Create the parent directory if it doesn't exist
    if let Some(parent) = config_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create config directory: {}", e))?;
    }

    // Read the existing config
    let mut config_content = if config_path.exists() {
        std::fs::read_to_string(&config_path)
            .map_err(|e| format!("Failed to read rclone config: {}", e))?
    } else {
        String::new()
    };

    // Generate the new remote configuration
    let remote_name = config.get("remote_name").ok_or("remote_name is required")?;
    let mut remote_config = format!("\n[{}]\ntype = {}\n", remote_name, plugin_name);

    for (key, value) in &config {
        if key != "remote_name" {  // Skip the remote name field as it's used for the section name
            remote_config.push_str(&format!("{} = {}\n", key, value));
        }
    }

    // Append the new remote to the config
    config_content.push_str(&remote_config);

    // Write the updated config back
    std::fs::write(&config_path, config_content)
        .map_err(|e| format!("Failed to write rclone config: {}", e))?;

    Ok(CommandResult {
        success: true,
        message: format!("Successfully added remote '{}'", remote_name),
    })
}

// Open file dialog using Tauri v2 dialog plugin
#[tauri::command]
async fn open_file_dialog(app_handle: tauri::AppHandle) -> Result<Option<String>, String> {
    let file_path = app_handle.dialog().file()
        .add_filter("Config Files", &["conf"])
        .blocking_pick_file();

    match file_path {
        Some(path) => Ok(Some(path.to_string())),
        None => Ok(None),
    }
}



fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            get_remotes,
            mount_remote,
            unmount_remote,
            test_connection,
            open_folder,
            add_to_cron,
            remove_from_cron,
            is_remote_in_cron,
            is_rclone_installed,
            get_available_plugins,
            add_remote_with_plugin,
            open_file_dialog
        ])
        .setup(|app| {
            // Set window title - add error handling
            if let Some(window) = app.get_webview_window("main") {
                if let Err(e) = window.set_title("Rclone Manager") {
                    eprintln!("Failed to set window title: {}", e);
                }
            } else {
                eprintln!("Failed to get main window");
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}