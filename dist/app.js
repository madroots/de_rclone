import { invoke } from '@tauri-apps/api/core';
import { dialog } from '@tauri-apps/api';

// DOM elements
let remoteTableBody, mountBtn, unmountBtn, openBtn, refreshBtn, testBtn, addRemoteBtn, debugBtn, configPathBtn, statusText, settingsBtn;

// Currently selected remote
let selectedRemote = null;

// Initialize the app
document.addEventListener('DOMContentLoaded', async () => {
    console.log("Document loaded, Tauri API imported");

    // Get DOM elements after they are loaded
    remoteTableBody = document.getElementById('remote-table-body');
    mountBtn = document.getElementById('mount-btn');
    unmountBtn = document.getElementById('unmount-btn');
    openBtn = document.getElementById('open-btn');
    refreshBtn = document.getElementById('refresh-btn');
    testBtn = document.getElementById('test-btn');
    addRemoteBtn = document.getElementById('add-remote-btn');
    debugBtn = document.getElementById('debug-btn');
    configPathBtn = document.getElementById('config-path-btn');
    statusText = document.getElementById('status-text');
    settingsBtn = document.getElementById('settings-btn');
    
    // Try to load remotes
    await loadRemotes();
    
    // Event listeners
    mountBtn.addEventListener('click', mountSelected);
    unmountBtn.addEventListener('click', unmountSelected);
    openBtn.addEventListener('click', openSelected);
    refreshBtn.addEventListener('click', loadRemotes);
    testBtn.addEventListener('click', testSelected);
    addRemoteBtn.addEventListener('click', addRemote);
    debugBtn.addEventListener('click', debugTest);
    configPathBtn.addEventListener('click', showConfigPath);
    settingsBtn.addEventListener('click', openSettings);
});

// Function to load remotes from backend
async function loadRemotes() {
    try {
        showStatus('Loading remotes...', 'info');

        // Using the imported invoke function
        const remotes = await invoke('get_remotes');

        renderRemotesTable(remotes);
        showStatus(`Loaded ${remotes.length} remotes`, 'success');
    } catch (error) {
        console.error('Error loading remotes:', error);
        const errorMessage = `Error loading remotes: ${error.message}`;
        showStatus(errorMessage, 'error');

        // Specific error message for common issues
        if (error.message.includes("rclone.conf not found")) {
            showStatus("Rclone config not found. Run 'rclone config' to configure remotes.", 'error');
        } else if (error.message.includes("Failed to read config")) {
            showStatus("Could not read rclone config. Check ~/.config/rclone/rclone.conf", 'error');
        }

        throw error; // Re-throw so calling code can handle it
    }
}

// Function to render remotes in the table
function renderRemotesTable(remotes) {
    remoteTableBody.innerHTML = '';
    
    if (!remotes || remotes.length === 0) {
        const row = document.createElement('tr');
        row.innerHTML = '<td colspan="5" style="text-align: center;">No remotes configured. Please configure rclone remotes in ~/.config/rclone/rclone.conf</td>';
        remoteTableBody.appendChild(row);
        return;
    }
    
    remotes.forEach(remote => {
        const row = document.createElement('tr');
        if (remote.mounted === 'Yes') {
            row.classList.add('mounted');
        }
        
        row.innerHTML = `
            <td>${remote.name}</td>
            <td>${remote.type}</td>
            <td>${remote.mounted}</td>
            <td>${remote.cron}</td>
            <td>${remote.mount_point}</td>
        `;
        
        row.addEventListener('click', () => {
            // Remove selection from other rows
            document.querySelectorAll('#remote-table-body tr').forEach(r => {
                r.style.backgroundColor = '';
            });
            
            // Highlight selected row
            row.style.backgroundColor = 'var(--accent)';
            selectedRemote = remote;
            updateButtonStates(remote);
        });
        
        remoteTableBody.appendChild(row);
    });
}

// Function to update button states based on selected remote
function updateButtonStates(remote) {
    if (!remote) {
        mountBtn.disabled = true;
        unmountBtn.disabled = true;
        openBtn.disabled = true;
        testBtn.disabled = true;
        return;
    }
    
    mountBtn.disabled = remote.mounted === 'Yes';
    unmountBtn.disabled = remote.mounted !== 'Yes';
    openBtn.disabled = remote.mounted !== 'Yes';
    testBtn.disabled = false;
}

// Function to show status message
function showStatus(message, type = 'info') {
    statusText.textContent = message;
    
    // Reset styles
    statusText.style.color = '';
    
    // Apply color based on type
    switch (type) {
        case 'success':
            statusText.style.color = '#7fff7f';
            break;
        case 'error':
            statusText.style.color = '#ff7f7f';
            break;
        case 'warning':
            statusText.style.color = '#ffff7f';
            break;
        case 'info':
        default:
            statusText.style.color = 'var(--text)';
    }
}

// Mount selected remote
async function mountSelected() {
    if (!selectedRemote) {
        await dialog.message('Please select a remote to mount', { title: 'Warning', type: 'warning' });
        return;
    }
    
    const remoteName = selectedRemote.name;
    
    try {
        showStatus(`Mounting ${remoteName}...`, 'info');
        
        const result = await invoke('mount_remote', { remoteName });
        showStatus(result.message, result.success ? 'success' : 'error');
        
        if (result.success) {
            await loadRemotes(); // Refresh the table
            await dialog.message(result.message, { title: 'Mount Successful', type: 'info' });
        } else {
            await dialog.message(result.message, { title: 'Mount Failed', type: 'error' });
        }
    } catch (error) {
        console.error('Error mounting remote:', error);
        showStatus(`Mount failed: ${error.message}`, 'error');
        await dialog.message(`Mount failed: ${error.message}`, { title: 'Mount Failed', type: 'error' });
    }
}

// Unmount selected remote
async function unmountSelected() {
    if (!selectedRemote) {
        await dialog.message('Please select a remote to unmount', { title: 'Warning', type: 'warning' });
        return;
    }
    
    const remoteName = selectedRemote.name;
    
    try {
        showStatus(`Unmounting ${remoteName}...`, 'info');
        
        const result = await invoke('unmount_remote', { remoteName });
        showStatus(result.message, result.success ? 'success' : 'error');
        
        if (result.success) {
            await loadRemotes(); // Refresh the table
            await dialog.message(result.message, { title: 'Unmount Successful', type: 'info' });
        } else {
            await dialog.message(result.message, { title: 'Unmount Failed', type: 'error' });
        }
    } catch (error) {
        console.error('Error unmounting remote:', error);
        showStatus(`Unmount failed: ${error.message}`, 'error');
        await dialog.message(`Unmount failed: ${error.message}`, { title: 'Unmount Failed', type: 'error' });
    }
}

// Open selected remote folder
async function openSelected() {
    if (!selectedRemote || selectedRemote.mounted !== 'Yes') {
        await dialog.message('Please select a mounted remote to open', { title: 'Warning', type: 'warning' });
        return;
    }
    
    const mountPoint = selectedRemote.mount_point;
    
    try {
        showStatus(`Opening folder: ${mountPoint}`, 'info');
        await invoke('open_folder', { path: mountPoint });
    } catch (error) {
        console.error('Error opening folder:', error);
        showStatus(`Error opening folder: ${error.message}`, 'error');
        await dialog.message(`Error opening folder: ${error.message}`, { title: 'Error', type: 'error' });
    }
}

// Test selected remote connection
async function testSelected() {
    if (!selectedRemote) {
        await dialog.message('Please select a remote to test', { title: 'Warning', type: 'warning' });
        return;
    }
    
    const remoteName = selectedRemote.name;
    
    try {
        showStatus(`Testing connection to ${remoteName}...`, 'info');
        
        const result = await invoke('test_connection', { remoteName });
        showStatus(result.message, result.success ? 'success' : 'error');
        
        if (result.success) {
            await dialog.message(result.message, { title: 'Test Successful', type: 'info' });
        } else {
            await dialog.message(result.message, { title: 'Test Failed', type: 'error' });
        }
    } catch (error) {
        console.error('Error testing remote:', error);
        showStatus(`Test failed: ${error.message}`, 'error');
        await dialog.message(`Test failed: ${error.message}`, { title: 'Test Failed', type: 'error' });
    }
}

// Open settings
async function openSettings() {
    // Create a simple settings dialog with configurable options
    const settingsHtml = `
        <div style="padding: 20px; background: var(--bg); color: var(--text);">
            <h3>Settings</h3>
            <div style="margin: 10px 0;">
                <label>Config Path:</label>
                <input type="text" id="config-path" style="background: var(--secondary-bg); color: var(--text); border: 1px solid var(--border-dark); width: 100%; padding: 5px;">
            </div>
            <div style="margin: 10px 0;">
                <label>Theme:</label>
                <select id="theme-select" style="background: var(--secondary-bg); color: var(--text); border: 1px solid var(--border-dark); padding: 5px;">
                    <option value="cs16">CS 1.6 Steam</option>
                </select>
            </div>
            <div style="margin: 15px 0; text-align: right;">
                <button class="cs-btn" onclick="document.getElementById('settings-modal').remove()">OK</button>
                <button class="cs-btn" onclick="document.getElementById('settings-modal').remove()" style="margin-left: 5px;">Cancel</button>
            </div>
        </div>
    `;

    // Create modal div
    const modal = document.createElement('div');
    modal.id = 'settings-modal';
    modal.innerHTML = settingsHtml;
    modal.style.position = 'fixed';
    modal.style.top = '50%';
    modal.style.left = '50%';
    modal.style.transform = 'translate(-50%, -50%)';
    modal.style.backgroundColor = 'var(--bg)';
    modal.style.border = '1px solid var(--border-light)';
    modal.style.padding = '20px';
    modal.style.zIndex = '1000';
    modal.style.width = '400px';

    document.body.appendChild(modal);
}

// Add a new remote
async function addRemote() {
    // First get available plugins to know what types of remotes we can add
    try {
        const plugins = await invoke('get_available_plugins');

        if (plugins.length === 0) {
            await dialog.message('No remote plugins available. You can configure remotes using rclone config directly.', {
                title: 'No Plugins Available',
                type: 'info'
            });
            return;
        }

        // Present user with plugin selection
        let pluginOptions = '';
        plugins.forEach(plugin => {
            pluginOptions += `<option value="${plugin.name}">${plugin.display_name}</option>`;
        });

        const addRemoteHtml = `
            <div style="padding: 20px; background: var(--bg); color: var(--text);">
                <h3>Add New Remote</h3>
                <div style="margin: 10px 0;">
                    <label>Remote Type:</label>
                    <select id="remote-type" style="background: var(--secondary-bg); color: var(--text); border: 1px solid var(--border-dark); padding: 5px; width: 100%;">
                        ${pluginOptions}
                    </select>
                </div>
                <div style="margin: 10px 0;">
                    <label>Remote Name:</label>
                    <input type="text" id="remote-name" placeholder="Enter remote name" style="background: var(--secondary-bg); color: var(--text); border: 1px solid var(--border-dark); width: 100%; padding: 5px;">
                </div>
                <div id="plugin-fields" style="margin: 10px 0;">
                    <!-- Plugin-specific fields will be loaded here -->
                </div>
                <div style="margin: 15px 0; text-align: right;">
                    <button class="cs-btn" onclick="addRemoteSubmit()">Add Remote</button>
                    <button class="cs-btn" onclick="document.getElementById('add-remote-modal').remove()" style="margin-left: 5px;">Cancel</button>
                </div>
            </div>
        `;

        // Create modal div
        const modal = document.createElement('div');
        modal.id = 'add-remote-modal';
        modal.innerHTML = addRemoteHtml;
        modal.style.position = 'fixed';
        modal.style.top = '50%';
        modal.style.left = '50%';
        modal.style.transform = 'translate(-50%, -50%)';
        modal.style.backgroundColor = 'var(--bg)';
        modal.style.border = '1px solid var(--border-light)';
        modal.style.padding = '20px';
        modal.style.zIndex = '1000';
        modal.style.width = '500px';

        document.body.appendChild(modal);

        // Add the submit function to window so it can be called from the modal
        window.addRemoteSubmit = async function() {
            const remoteType = document.getElementById('remote-type').value;
            const remoteName = document.getElementById('remote-name').value.trim();

            if (!remoteName) {
                await dialog.message('Please enter a remote name', { title: 'Error', type: 'error' });
                return;
            }

            // Get plugin to see what fields are needed
            const plugin = plugins.find(p => p.name === remoteType);
            if (!plugin) {
                await dialog.message('Invalid plugin selected', { title: 'Error', type: 'error' });
                return;
            }

            // Build the config object from the input fields
            const config = { remote_name: remoteName };

            // Add values for each required field
            plugin.fields.forEach(field => {
                const element = document.getElementById(`field-${field.name}`);
                if (element) {
                    config[field.name] = element.value || field.default;
                }
            });

            try {
                const result = await invoke('add_remote_with_plugin', {
                    pluginName: remoteType,
                    config: config
                });

                if (result.success) {
                    await dialog.message(result.message, { title: 'Success', type: 'info' });
                    document.getElementById('add-remote-modal').remove();
                    await loadRemotes(); // Refresh the list
                } else {
                    await dialog.message(result.message, { title: 'Failed', type: 'error' });
                }
            } catch (error) {
                console.error('Error adding remote:', error);
                await dialog.message(`Failed to add remote: ${error.message}`, { title: 'Error', type: 'error' });
            }
        };

        // When a remote type is selected, load its specific fields
        document.getElementById('remote-type').addEventListener('change', async function() {
            const selectedPluginName = this.value;
            const selectedPlugin = plugins.find(p => p.name === selectedPluginName);

            if (selectedPlugin) {
                let fieldsHtml = '<div style="margin-top: 10px;"><h4>Configuration Fields:</h4>';

                selectedPlugin.fields.forEach(field => {
                    const defaultValue = field.default || '';
                    const placeholder = field.placeholder || '';

                    let fieldHtml = '';
                    switch (field.field_type) {
                        case 'password':
                            fieldHtml = `<input type="password" id="field-${field.name}" placeholder="${placeholder}" value="${defaultValue}" style="background: var(--secondary-bg); color: var(--text); border: 1px solid var(--border-dark); width: 100%; padding: 5px;">`;
                            break;
                        case 'checkbox':
                            const checked = defaultValue === 'true' ? 'checked' : '';
                            fieldHtml = `<input type="checkbox" id="field-${field.name}" ${checked} style="margin-right: 5px;">`;
                            break;
                        case 'file':
                            fieldHtml = `<input type="file" id="field-${field.name}" placeholder="${placeholder}" value="${defaultValue}" style="background: var(--secondary-bg); color: var(--text); border: 1px solid var(--border-dark); width: 100%; padding: 5px;">`;
                            break;
                        case 'number':
                            fieldHtml = `<input type="number" id="field-${field.name}" placeholder="${placeholder}" value="${defaultValue}" style="background: var(--secondary-bg); color: var(--text); border: 1px solid var(--border-dark); width: 100%; padding: 5px;">`;
                            break;
                        default: // text, etc.
                            fieldHtml = `<input type="text" id="field-${field.name}" placeholder="${placeholder}" value="${defaultValue}" style="background: var(--secondary-bg); color: var(--text); border: 1px solid var(--border-dark); width: 100%; padding: 5px;">`;
                            break;
                    }

                    fieldsHtml += `
                        <div style="margin: 8px 0;">
                            <label>${field.display_name}${field.required ? ' *' : ''}:</label>
                            ${fieldHtml}
                        </div>
                    `;
                });

                fieldsHtml += '</div>';
                document.getElementById('plugin-fields').innerHTML = fieldsHtml;
            }
        });

        // Trigger the change event to load fields for the default selection
        document.getElementById('remote-type').dispatchEvent(new Event('change'));
    } catch (error) {
        console.error('Error getting plugins:', error);
        await dialog.message('Error getting remote types: ' + error.message, {
            title: 'Error',
            type: 'error'
        });
    }
}

// Debug test function
async function debugTest() {
    try {
        // Test with a simple hello world dialog
        await dialog.message('Hello World! Debug test successful.', { title: 'Debug Test', type: 'info' });
    } catch (error) {
        console.error('Debug test error:', error);
        await dialog.message(`Debug test failed: ${error.message}`, { title: 'Debug Error', type: 'error' });
    }
}

// Show config path function
async function showConfigPath() {
    try {
        // Create a dialog showing the expected config path
        await dialog.message('Expected config path: ~/.config/rclone/rclone.conf', {
            title: 'Config Path Info',
            type: 'info'
        });
    } catch (error) {
        console.error('Config path error:', error);
        await dialog.message(`Error showing config path: ${error.message}`, {
            title: 'Config Path Error',
            type: 'error'
        });
    }
}

// Export functions for Tauri commands to use if needed
window.rcloneManager = {
    loadRemotes,
    showStatus
};