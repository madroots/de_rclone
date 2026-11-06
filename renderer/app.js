// de_rclone - Tauri v2 API Interface
// Global variables for Tauri functions
let invoke, dialog;

// DOM elements
let remoteTableBody, mountBtn, unmountBtn, openBtn, refreshBtn, testBtn, addRemoteBtn, configPathBtn, statusText, settingsBtn;

// Currently selected remote
let selectedRemote = null;

// Operation tracking to prevent multiple simultaneous operations
let isOperationInProgress = false;

// Electron prefixes errors thrown by IPC handlers with "Error invoking remote
// method '<name>': Error: "; handlers prefix their own typed errors with
// "CODE: ". These helpers expose the readable text and the code.
function cleanIpcError(error) {
  const raw = error && typeof error === 'object' && error.message ? error.message : String(error);
  return raw.replace(/^Error invoking remote method '[^']*': (?:\w*Error: )?/, '');
}

function stripErrorCode(message) {
  return message.replace(/^[A-Z][A-Z_]+: /, '');
}

// Remove a remote that this session just created. The backend only accepts
// rollback for names it created itself, and the result is always checked: a
// silent failure would leave a remote the user believes was discarded.
async function rollbackNewRemote(remoteName, configPath) {
  try {
    const result = await invoke('delete_remote', { remoteName, configPathOpt: configPath, rollback: true });
    if (result && result.success) return true;
    showGeneralModal('Error', `Could not remove the new remote '${escapeHtml(remoteName)}': ${escapeHtml(result?.message || 'unknown error')}<br><br>It is still in your rclone config. Delete it from the right-click menu.`);
  } catch (error) {
    showGeneralModal('Error', `Could not remove the new remote '${escapeHtml(remoteName)}': ${escapeHtml(stripErrorCode(cleanIpcError(error)))}<br><br>It is still in your rclone config. Delete it from the right-click menu.`);
  }
  await loadRemotes();
  return false;
}

// Escape values that come from rclone.conf before inserting them into HTML.
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[ch]));
}

// Single source of truth for rendering a plugin field. `type: file` fields use
// a text input plus a native picker because <input type="file"> only exposes
// C:\fakepath\... through .value.
function buildFieldHtml(field, value) {
  const id = `field-${field.name}`;
  const placeholder = escapeHtml(field.placeholder || '');
  const currentValue = escapeHtml(value ?? '');
  switch (field.type) {
    case 'password':
      return `<input type="password" id="${id}" class="cs-input" placeholder="${placeholder}" value="${currentValue}" style="width: 100%;">`;
    case 'checkbox': {
      const checked = String(value ?? field.default ?? 'false') === 'true' ? 'checked' : '';
      return `<input type="checkbox" id="${id}" ${checked} style="margin-right: 5px;">`;
    }
    case 'file':
      return `<div style="display: flex; gap: 4px; align-items: center;">
        <input type="text" id="${id}" class="cs-input" placeholder="${placeholder}" value="${currentValue}" style="flex: 1;">
        <button type="button" class="cs-btn browse-file-btn" data-target="${id}" style="white-space: nowrap;">Browse...</button>
      </div>`;
    case 'number':
      return `<input type="number" id="${id}" class="cs-input" placeholder="${placeholder}" value="${currentValue}" style="width: 100%;">`;
    default:
      return `<input type="text" id="${id}" class="cs-input" placeholder="${placeholder}" value="${currentValue}" style="width: 100%;">`;
  }
}

function bindFileBrowseButtons(container) {
  container.querySelectorAll('.browse-file-btn').forEach(button => {
    button.addEventListener('click', async () => {
      const target = document.getElementById(button.dataset.target);
      if (!target) return;
      try {
        const selected = await invoke('select_file');
        if (selected) target.value = selected;
      } catch (e) {
        showStatus(`Failed to open file picker: ${e.message || e}`, 'error');
      }
    });
  });
}

// Initialize the app when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
  console.log("de_rclone: Initializing app...");

  // Initialize Tauri API functions
  initializeTauriAPI();

  // Get DOM elements
  remoteTableBody = document.getElementById('remote-table-body');
  mountBtn = document.getElementById('mount-btn');
  unmountBtn = document.getElementById('unmount-btn');
  openBtn = document.getElementById('open-btn');
  refreshBtn = document.getElementById('refresh-btn');
  testBtn = document.getElementById('test-btn');
  addRemoteBtn = document.getElementById('add-remote-btn');
  statusText = document.getElementById('status-text');
  settingsBtn = document.getElementById('settings-btn');

  // Set up event listeners with debugging
  setupEventListeners();

  // Load version
  // Load version
  invoke('get_app_version').then(version => {
    const el = document.getElementById('app-version');
    if (el) {
      el.textContent = `v${version}`;
      el.addEventListener('click', () => {
        const aboutContent = `
          <div style="text-align: center;">
            <p style="font-weight: bold; margin-bottom: 10px;">de_rclone manager v${version}</p>
            <p style="margin-bottom: 15px;">A robust Rclone GUI manager built with Electron.</p>
            <p>
              <a href="#" onclick="window.api.shell.openExternal('https://github.com/madroots/de_rclone')" style="color: var(--accent); text-decoration: none;">GitHub Repository</a>
            </p>
            <p>
              <a href="#" onclick="window.api.shell.openExternal('https://github.com/ekmas/cs16.css')" style="color: var(--accent); text-decoration: none;">CS 1.6 CSS Framework</a>
            </p>
          </div>
        `;
        showGeneralModal('About de_rclone', aboutContent);
      });
    }
  }).catch(e => console.error("Failed to load version", e));

  // Load remotes
  loadRemotes().catch(error => {
    console.error('Failed to load remotes:', error);
    showStatus(`Failed to load remotes: ${error.message}`, 'error');
  });

  // Check for legacy mounts and crons after a short delay
  setTimeout(checkLegacyState, 1000);
});

async function checkLegacyState() {
  if (!window.api || !window.api.invoke) return; // Wait for initialization
  try {
    const state = await invoke('check_legacy_state');
    const hasMounts = state.mounts && state.mounts.length > 0;
    const hasCrons = state.legacyCrons && state.legacyCrons.length > 0;

    if (hasMounts || hasCrons) {
      showLegacyStateWarning(state);
    }
  } catch (e) {
    console.error("Failed to check legacy state:", e);
  }
}

// Lists leftovers of the old ~/mnt setup. Nothing is selected by default and
// nothing is removed unless the user ticks that exact item and confirms.
function showLegacyStateWarning(state) {
  const mounts = state.mountDetails || (state.mounts || []).map(path => ({ path, source: '' }));
  const crons = state.legacyCrons || [];
  const modal = document.createElement('div');
  modal.className = 'progress-modal';

  const notes = [state.mountsError && `mounts: ${state.mountsError}`, state.cronNote && `crontab: ${state.cronNote}`].filter(Boolean);
  let detailsHtml = '';
  if (mounts.length > 0) {
    detailsHtml += `
      <strong>rclone mounts in ~/mnt:</strong>
      <ul style="list-style: none; padding: 0; margin: 5px 0 10px; max-height: 100px; overflow-y: auto;">
        ${mounts.map((m, i) => `<li><label><input type="checkbox" class="legacy-mount" data-index="${i}"> ${escapeHtml(m.path)}${m.source ? ` <span class="text-muted">(${escapeHtml(m.source)})</span>` : ''}</label></li>`).join('')}
      </ul>
    `;
  }
  if (crons.length > 0) {
    detailsHtml += `
      <strong>Legacy auto-mount entries (cron):</strong>
      <ul style="list-style: none; padding: 0; margin: 5px 0 10px; max-height: 120px; overflow-y: auto;">
        ${crons.map((entry, i) => `<li><label style="font-family: monospace; font-size: 0.85em; word-break: break-all;"><input type="checkbox" class="legacy-cron" data-index="${i}"> ${escapeHtml(entry)}</label></li>`).join('')}
      </ul>
    `;
  }

  modal.innerHTML = `
    <div class="progress-modal-content">
      <div class="progress-header">
        <span class="progress-title">Legacy Setup Detected</span>
      </div>
      <div class="progress-body" style="padding: 15px;">
        <div class="progress-message" id="legacy-body" style="margin-bottom: 15px;">
          The mount location has been updated to $XDG_RUNTIME_DIR.<br/><br/>
          These parts of the old setup are still present. Tick only the items you want removed:
          <div style="margin-top: 10px; font-size: 0.9em; text-align: left;">
            ${detailsHtml}
          </div>
          ${notes.length ? `<div class="text-muted" style="font-size: 0.85em;">${notes.map(escapeHtml).join('<br/>')}</div>` : ''}
        </div>
        <div class="progress-content" style="display: flex; justify-content: flex-end; gap: 10px; margin-top: 10px;">
          <button class="cs-btn" id="legacy-cleanup-btn" disabled>Remove selected</button>
          <button class="cs-btn" id="legacy-ignore-btn">Ignore</button>
        </div>
      </div>
    </div>
  `;

  document.body.appendChild(modal);

  const cleanupBtn = document.getElementById('legacy-cleanup-btn');
  const selected = () => ({
    mounts: [...modal.querySelectorAll('.legacy-mount:checked')].map(el => mounts[Number(el.dataset.index)].path),
    crons: [...modal.querySelectorAll('.legacy-cron:checked')].map(el => crons[Number(el.dataset.index)])
  });
  const refreshButton = () => {
    const { mounts: m, crons: c } = selected();
    cleanupBtn.disabled = m.length + c.length === 0;
    cleanupBtn.textContent = m.length + c.length === 0 ? 'Remove selected' : `Remove selected (${m.length + c.length})`;
  };
  modal.querySelectorAll('input[type="checkbox"]').forEach(el => el.addEventListener('change', refreshButton));

  cleanupBtn.addEventListener('click', async () => {
    const pick = selected();
    cleanupBtn.disabled = true;
    cleanupBtn.textContent = 'Removing...';
    const lines = [];
    let allOk = true;

    try {
      if (pick.mounts.length > 0) {
        const result = await invoke('unmount_legacy_mounts', pick.mounts);
        for (const item of result.results || []) {
          lines.push(`${item.ok ? 'Unmounted' : 'FAILED'}: ${item.path}${item.ok ? '' : ` (${item.error})`}`);
        }
        if (!result.success) {
          allOk = false;
          if (result.error) lines.push(`FAILED: ${result.error}`);
        }
      }
      if (pick.crons.length > 0) {
        const result = await invoke('remove_legacy_crons', pick.crons);
        if (result.success) {
          lines.push(`Removed ${result.count} cron entr${result.count === 1 ? 'y' : 'ies'}`);
        } else {
          allOk = false;
          lines.push(`FAILED: cron entries (${result.error || 'unknown error'})`);
        }
      }
    } catch (e) {
      allOk = false;
      lines.push(`FAILED: ${stripErrorCode(cleanIpcError(e))}`);
    }

    showStatus(allOk ? 'Removed the selected legacy items.' : 'Some selected legacy items could not be removed.', allOk ? 'success' : 'warning');
    document.getElementById('legacy-body').innerHTML = lines.map(escapeHtml).join('<br/>');
    modal.querySelector('.progress-content').innerHTML = '<button class="cs-btn" id="legacy-done-btn">OK</button>';
    document.getElementById('legacy-done-btn').addEventListener('click', () => modal.remove());
    loadRemotes();
  });

  document.getElementById('legacy-ignore-btn').addEventListener('click', () => {
    modal.remove();
  });
}

// Initialize Tauri API functions properly for v2
function initializeTauriAPI() {
  // Check for Electron API
  if (window.api && window.api.invoke) {
    console.log("Electron API available via window.api");
    invoke = window.api.invoke;
  } else {
    console.error("Electron API not found in global scope!");

    // Mock functions as fallback for testing
    invoke = async (cmd, args) => {
      console.log(`[MOCK] invoke: ${cmd}`, args);
      if (cmd === 'get_remotes') {
        return [];
      }
      return { success: true, message: `[MOCK] Response from ${cmd}` };
    };
  }
}

// Set up event listeners with debugging
function setupEventListeners() {
  console.log("Setting up event listeners...");

  if (mountBtn) {
    mountBtn.addEventListener('click', () => {
      console.log("Mount button clicked");
      mountSelected();
    });
  }

  if (unmountBtn) {
    unmountBtn.addEventListener('click', () => {
      console.log("Unmount button clicked");
      unmountSelected();
    });
  }

  if (openBtn) {
    openBtn.addEventListener('click', () => {
      console.log("Open button clicked");
      openSelected();
    });
  }

  if (refreshBtn) {
    refreshBtn.addEventListener('click', () => {
      console.log("Refresh button clicked");
      loadRemotes();
    });
  }

  if (testBtn) {
    testBtn.addEventListener('click', () => {
      console.log("Test button clicked");
      testSelected();
    });
  }

  if (addRemoteBtn) {
    addRemoteBtn.addEventListener('click', () => {
      console.log("Add Remote button clicked");
      addRemote();
    });
  }

  if (settingsBtn) {
    settingsBtn.addEventListener('click', () => {
      console.log("Settings button clicked");
      openSettings();
    });
  }
}

// Function to load remotes from backend
async function loadRemotes() {
  try {
    console.log("Loading remotes...");
    showStatus('Loading remotes...', 'info');

    // Get the config path from localStorage or use default
    const configPath = localStorage.getItem('rcloneConfigPath');
    const configPathFinal = configPath || null;
    const remotes = await invoke('get_remotes', { configPathOpt: configPathFinal });

    await renderRemotesTable(remotes);

    // Restore selection: rows were re-created and the previously selected
    // remote object is now stale (e.g. mounted state changed after mount/unmount),
    // which left Open Folder disabled until the user re-clicked the row.
    if (selectedRemote) {
      const fresh = remotes.find(r => r.name === selectedRemote.name);
      selectedRemote = fresh || null;
      updateButtonStates(selectedRemote);
      if (fresh) {
        const row = [...document.querySelectorAll('#remote-table-body tr')]
          .find(tr => tr.children[1]?.textContent === fresh.name);
        if (row) row.style.backgroundColor = 'var(--secondary-accent)';
      }
    }

    const cronNotes = [...new Set(remotes.map(r => r.cron_note).filter(Boolean))];
    const message = `Loaded ${remotes.length} remotes${cronNotes.length ? ` (${cronNotes.join('; ')})` : ''}`;
    defaultStatusMessage = message; // Update the default message
    showStatus(message, 'success', false); // Don't auto-reset the loaded message
  } catch (error) {
    console.error('Error loading remotes:', error);
    const errorMessage = cleanIpcError(error);

    // Never leave rows from an earlier load on screen: they would pass for the
    // current state of a config that can no longer be read.
    if (remoteTableBody) remoteTableBody.innerHTML = '';
    updateRemoteHeader(0);
    selectedRemote = null;
    updateButtonStates(null);

    if (errorMessage.includes('rclone.conf not found')) {
      const text = 'rclone.conf not found. Select it from settings or add a new remote to create it.';
      showStatus(text, 'warning', false); // Yellow and doesn't auto-reset
      defaultStatusMessage = text; // Keep this as the persistent message
    } else if (errorMessage.startsWith('CONFIG_ENCRYPTED:')) {
      const text = stripErrorCode(errorMessage);
      showStatus(text, 'warning', false);
      defaultStatusMessage = text;
    } else {
      defaultStatusMessage = 'Ready';
      showStatus(`Error loading remotes: ${stripErrorCode(errorMessage)}`, 'error');
    }
  }
}

// Function to render remotes in the table
async function renderRemotesTable(remotes) {
  if (!remoteTableBody) {
    console.error("remoteTableBody element not found");
    return;
  }

  remoteTableBody.innerHTML = '';

  // Update the header to show the count
  updateRemoteHeader(remotes?.length || 0);

  // Update the "No remotes" message to account for the new column
  if (!remotes || remotes.length === 0) {
    const row = document.createElement('tr');
    row.innerHTML = '<td colspan="7" style="text-align: center; padding: 0px;">No remotes configured. Please configure rclone remotes in ~/.config/rclone/rclone.conf</td>';
    remoteTableBody.appendChild(row);
    return;
  }

  // Get available plugins to check secure status
  const plugins = await invoke('get_available_plugins');

  // Process remotes after getting plugins
  remotes.forEach(remote => {
    const row = document.createElement('tr');
    if (remote.mounted === 'Yes') {
      row.classList.add('mounted');
    }

    // Check if this remote type is secure based on its plugin
    // Look for exact match first (more reliable)
    let remotePlugin = plugins.find(p => p.name.toLowerCase() === remote.type.toLowerCase());

    // If no exact match, try matching in display name
    if (!remotePlugin) {
      remotePlugin = plugins.find(p => p.display_name.toLowerCase() === remote.type.toLowerCase());
    }

    const isSecure = remotePlugin && remotePlugin.secure === true;
    const securityIcon = isSecure ? '<img src="shield.svg" alt="Secure" style="width: 14px; height: 14px; vertical-align: middle;">' : ''; // Shield for secure, empty for non-secure

    row.innerHTML = `
      <td style="text-align: center; padding: 0px;">${securityIcon}</td>
      <td>${escapeHtml(remote.name)}</td>
      <td>${escapeHtml(remote.type)}</td>
      <td>${escapeHtml(remote.mounted)}</td>
      <td>${escapeHtml(remote.cron)}</td>
      <td>${escapeHtml(remote.mount_point)}</td>
      <td><span id="latency-${escapeHtml(remote.name)}" class="text-muted">...</span></td>
    `;

    row.addEventListener('click', () => {
      // Remove selection from other rows
      document.querySelectorAll('#remote-table-body tr').forEach(r => {
        r.style.backgroundColor = '';
      });

      // Highlight selected row with more golden color
      row.style.backgroundColor = 'var(--secondary-accent)';
      selectedRemote = remote;
      updateButtonStates(remote);
    });

    // Add right-click context menu
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault(); // Prevent default context menu

      // Remove selection from other rows
      document.querySelectorAll('#remote-table-body tr').forEach(r => {
        r.style.backgroundColor = '';
      });

      // Highlight selected row with more golden color
      row.style.backgroundColor = 'var(--secondary-accent)';
      selectedRemote = remote;
      updateButtonStates(remote);

      // Create custom context menu
      createContextMenu(e.clientX, e.clientY, remote);
    });

    remoteTableBody.appendChild(row);

    // Trigger latency check immediately
    checkLatency(remote.name);
  });
}

async function checkLatency(remoteName) {
  const el = document.getElementById(`latency-${remoteName}`);
  if (!el) return;

  // Set minimal text
  el.textContent = '...';

  try {
    const configPath = localStorage.getItem('rcloneConfigPath') || null;
    const result = await invoke('check_latency', { remoteName, configPathOpt: configPath });

    if (result.success) {
      el.textContent = `${result.latency}ms`;
      // Set color directly using style to avoid CSS parsing issues in some contexts
      if (result.latency < 200) el.style.color = '#38b038'; // Greenish
      else if (result.latency < 1000) el.style.color = '#c4b550'; // Yellowish
      else el.style.color = '#ff6b6b'; // Red
    } else {
      el.textContent = result.error === 'Timeout' ? 'Timeout' : 'Error';
      el.style.color = '#ff6b6b';
    }
  } catch (e) {
    el.textContent = 'Error';
    el.style.color = '#ff6b6b';
  }
}

// Function to update the header with remote count
function updateRemoteHeader(count) {
  const headerRow = document.querySelector('#remote-table thead tr');
  if (headerRow) {
    // Get the existing header cells to preserve other columns
    const currentHeaders = headerRow.querySelectorAll('th');
    if (currentHeaders.length >= 6) {
      // Update the second header (Remote) with the count, not the first (Shield)
      currentHeaders[1].textContent = `Remotes (${count})`;
    }
  }
}

// Function to update button states based on selected remote
function updateButtonStates(remote) {
  // Reset all buttons to disabled initially
  if (mountBtn) mountBtn.disabled = true;
  if (unmountBtn) {
    unmountBtn.disabled = true;
    unmountBtn.textContent = 'Unmount';
  }
  if (openBtn) openBtn.disabled = true;
  if (testBtn) testBtn.disabled = true;

  // Only enable buttons if a remote is selected
  if (remote) {
    const state = remote.mount_state || (remote.mounted === 'Yes' ? 'mounted' : 'unmounted');
    if (mountBtn) mountBtn.disabled = state !== 'unmounted';
    if (unmountBtn) {
      unmountBtn.disabled = state !== 'mounted' && state !== 'stale';
      unmountBtn.textContent = state === 'stale' ? 'Recover' : 'Unmount';
    }
    if (openBtn) openBtn.disabled = state !== 'mounted';
    if (testBtn) testBtn.disabled = false;
  }
}

// Store the default status message to be able to reset to it
let defaultStatusMessage = "Ready";

// Function to show status message
function showStatus(message, type = 'info', autoReset = true) {
  if (!statusText) {
    console.warn("statusText element not found");
    return;
  }

  statusText.textContent = message;

  // Reset styles
  statusText.style.color = '';

  // Apply the theme's accent yellow color for all activity messages
  switch (type) {
    case 'success':
      statusText.style.color = 'var(--accent)'; // Theme accent color (#c4b550)
      break;
    case 'error':
      statusText.style.color = '#ff0000'; // Red for errors
      break;
    case 'warning':
      statusText.style.color = 'var(--accent)'; // Theme accent color for warnings
      break;
    case 'info':
    default:
      statusText.style.color = 'var(--accent)'; // Theme accent color for info messages
  }

  // Auto-reset the status message after 5 seconds if requested
  if (autoReset) { // Always auto-reset after 5 seconds, including error messages
    if (window.statusResetTimer) {
      clearTimeout(window.statusResetTimer);
    }

    window.statusResetTimer = setTimeout(() => {
      statusText.textContent = defaultStatusMessage;
      statusText.style.color = 'var(--text)'; // Use the theme's default text color (white/light)
    }, 5000);
  }
}

// Mount selected remote
async function mountSelected() {
  if (!selectedRemote) {
    showGeneralModal('Warning', 'Please select a remote to mount');
    return;
  }

  const remoteName = selectedRemote.name;
  resetOperationCancellation(); // Reset cancellation flag

  // Show progress modal with cancel button
  const modal = showProgressDialog(`Mounting ${remoteName}...`, 'Cancel', remoteName, 'mount');

  try {
    // The backend waits for rclone's own mount readiness (up to 60s) and reports
    // the real outcome; this guard must outlast it so the UI never reports a
    // timeout for a mount that is still going to succeed.
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('Mount operation timed out after 70 seconds')), 70000);
    });

    // Get the config path from localStorage or use default (null)
    const configPath = localStorage.getItem('rcloneConfigPath') || null;
    // Race the invoke call with the timeout
    const result = await Promise.race([
      invoke('mount_remote', { remoteName, configPathOpt: configPath }),
      timeoutPromise
    ]);

    // Check if operation was cancelled during the call
    if (operationCancelled) {
      throw new Error('Operation cancelled');
    }

    // Handle case where response doesn't have proper structure
    const message = result?.message || 'Mount operation completed with unknown result';
    const success = result?.success || false;

    // Update status
    showStatus(message, success ? 'success' : 'error'); // This will auto-reset after 5s

    // Update modal with result
    if (success) {
      await loadRemotes(); // Refresh the table
      updateProgressModal(modal, 'Mount Successful', message, 'OK', 'mount-success');
    } else {
      // Check if it's an error with undefined message
      const errorMsg = message && message !== 'undefined' ? message : `Mount operation failed for remote: ${remoteName}`;
      updateProgressModal(modal, 'Mount Failed', errorMsg, 'OK', 'mount-error');
    }
  } catch (error) {
    // Check if the operation was cancelled
    if (error.message === 'Operation cancelled' || operationCancelled) {
      updateProgressModal(modal, 'Cancelled', 'Mount operation was cancelled', 'OK', 'mount-cancelled');
      showStatus('Mount operation cancelled', 'info');
      return;
    }

    console.error('Error mounting remote:', error);

    // Determine the specific error message
    let errorMessage = 'Mount operation failed';
    if (error && typeof error === 'object') {
      if (error.message) {
        errorMessage = error.message;
      } else if (error.toString && error.toString() !== '[object Object]') {
        errorMessage = error.toString();
      }
    } else if (error && typeof error === 'string') {
      errorMessage = error;
    }

    // Handle timeout specifically
    if (errorMessage.includes('timed out')) {
      errorMessage = `Unable to connect to remote: ${remoteName}`;
    } else if (errorMessage === 'undefined' || !errorMessage || errorMessage === '[object Object]') {
      errorMessage = `Unable to connect to remote: ${remoteName}`;
    }

    showStatus(`Mount failed: ${errorMessage}`, 'error'); // Errors don't auto-reset
    updateProgressModal(modal, 'Mount Failed', errorMessage, 'OK', 'mount-error');
  }
}

// Unmount selected remote
async function unmountSelected() {
  if (!selectedRemote) {
    showGeneralModal('Warning', 'Please select a remote to unmount');
    return;
  }

  const remoteName = selectedRemote.name;
  const recovering = selectedRemote.mount_state === 'stale';
  resetOperationCancellation(); // Reset cancellation flag

  // Show progress modal with cancel button
  const modal = showProgressDialog(`${recovering ? 'Recovering' : 'Unmounting'} ${remoteName}...`, 'Cancel', remoteName, 'unmount');

  try {
    // Create a timeout promise that rejects after 10 seconds to match test connection timeout
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('Unmount operation timed out after 10 seconds')), 10000);
    });

    // Get the config path from localStorage or use default (null)
    const configPath = localStorage.getItem('rcloneConfigPath') || null;
    // Race the invoke call with the timeout
    const result = await Promise.race([
      invoke(recovering ? 'recover_mount' : 'unmount_remote', { remoteName, configPathOpt: configPath }),
      timeoutPromise
    ]);

    // Check if operation was cancelled during the call
    if (operationCancelled) {
      throw new Error('Operation cancelled');
    }

    // Handle case where response doesn't have proper structure
    const message = result?.message || 'Unmount operation completed with unknown result';
    const success = result?.success || false;

    // Update status
    showStatus(message, success ? 'success' : 'error'); // This will auto-reset after 5s

    // Update modal with result
    if (success) {
      await loadRemotes(); // Refresh the table
      updateProgressModal(modal, 'Unmount Successful', message, 'OK', 'unmount-success');
    } else {
      // Check if it's an error with undefined message
      const errorMsg = message && message !== 'undefined' ? message : `Unmount operation failed for remote: ${remoteName}`;
      updateProgressModal(modal, 'Unmount Failed', errorMsg, 'OK', 'unmount-error');
    }
  } catch (error) {
    // Check if the operation was cancelled
    if (error.message === 'Operation cancelled' || operationCancelled) {
      updateProgressModal(modal, 'Cancelled', 'Unmount operation was cancelled', 'OK', 'unmount-cancelled');
      showStatus('Unmount operation cancelled', 'info');
      return;
    }

    console.error('Error unmounting remote:', error);

    // Determine the specific error message
    let errorMessage = 'Unmount operation failed';
    if (error && typeof error === 'object') {
      if (error.message) {
        errorMessage = error.message;
      } else if (error.toString && error.toString() !== '[object Object]') {
        errorMessage = error.toString();
      }
    } else if (error && typeof error === 'string') {
      errorMessage = error;
    }

    // Handle timeout specifically
    if (errorMessage.includes('timed out')) {
      errorMessage = `Unable to connect to remote: ${remoteName}`;
    } else if (errorMessage === 'undefined' || !errorMessage || errorMessage === '[object Object]') {
      errorMessage = `Unable to connect to remote: ${remoteName}`;
    }

    showStatus(`Unmount failed: ${errorMessage}`, 'error'); // Errors don't auto-reset
    updateProgressModal(modal, 'Unmount Failed', errorMessage, 'OK', 'unmount-error');
  }
}

// Open selected remote folder
async function openSelected() {
  if (!selectedRemote || selectedRemote.mounted !== 'Yes') {
    showGeneralModal('Warning', 'Please select a mounted remote to open');
    return;
  }

  const mountPoint = selectedRemote.mount_point;

  try {
    showStatus(`Opening folder: ${mountPoint}`, 'info'); // This will auto-reset after 5s
    await invoke('open_folder', { path: mountPoint });
  } catch (error) {
    console.error('Error opening folder:', error);
    showStatus(`Error opening folder: ${error.message}`, 'error'); // Errors don't auto-reset
    showGeneralModal('Error', `Error opening folder: ${error.message}`);
  }
}

// Global variable to track the current operation ID for cancellation
let currentOperationId = null;

// Test selected remote connection
async function testSelected() {
  if (!selectedRemote) {
    showGeneralModal('Warning', 'Please select a remote to test');
    return;
  }

  const remoteName = selectedRemote.name;
  resetOperationCancellation(); // Reset cancellation flag

  // Show progress modal with cancel button
  const modal = showProgressDialog(`Testing connection to ${remoteName}...`, 'Cancel', remoteName, 'test');

  try {
    // Create a timeout promise that rejects after 15 seconds (backend caps at 12s)
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('Test connection timed out after 15 seconds')), 15000);
    });

    // Get the config path from localStorage or use default (null)
    const configPath = localStorage.getItem('rcloneConfigPath') || null;
    // Race the invoke call with the timeout
    const result = await Promise.race([
      invoke('test_connection', { remoteName, configPathOpt: configPath }),
      timeoutPromise
    ]);

    // Check if operation was cancelled during the call
    if (operationCancelled) {
      throw new Error('Operation cancelled');
    }

    // Handle case where response doesn't have proper structure
    const message = result?.message || 'Connection test completed with unknown result';
    const success = result?.success || false;

    // Update status
    showStatus(message, success ? 'success' : 'error'); // This will auto-reset after 5s

    // Update modal with result
    if (success) {
      updateProgressModal(modal, 'Success', message, 'OK', 'test-success');
    } else {
      // Check if it's an error with undefined message
      const errorMsg = message && message !== 'undefined' ? message : `Connection test failed for remote: ${remoteName}`;
      updateProgressModal(modal, 'Test Failed', errorMsg, 'OK', 'test-error');
    }
  } catch (error) {
    // Check if the operation was cancelled
    if (error.message === 'Operation cancelled' || operationCancelled) {
      updateProgressModal(modal, 'Cancelled', 'Test connection operation was cancelled', 'OK', 'test-cancelled');
      showStatus('Test connection cancelled', 'info');
      return;
    }

    console.error('Error testing remote:', error);

    // Determine the specific error message
    let errorMessage = 'Connection test failed';
    if (error && typeof error === 'object') {
      if (error.message) {
        errorMessage = error.message;
      } else if (error.toString && error.toString() !== '[object Object]') {
        errorMessage = error.toString();
      }
    } else if (error && typeof error === 'string') {
      errorMessage = error;
    }

    // Handle timeout specifically
    if (errorMessage.includes('timed out')) {
      errorMessage = `Unable to connect to remote: ${remoteName}`;
    } else if (errorMessage === 'undefined' || !errorMessage || errorMessage === '[object Object]') {
      errorMessage = `Unable to connect to remote: ${remoteName}`;
    }

    showStatus(`Test failed: ${errorMessage}`, 'error'); // Errors don't auto-reset
    updateProgressModal(modal, 'Test Failed', errorMessage, 'OK', 'test-error');
  }
}

// Show progress dialog
function showProgressDialog(message, cancelText, remoteName, operationType) {
  // Create modal div
  const modal = document.createElement('div');
  modal.id = 'progress-modal';
  modal.className = 'progress-modal';

  // Determine the appropriate message based on operation type
  let operationMessage = message;
  if (operationType === 'test') {
    operationMessage = `Establishing network connection to ${remoteName}...`;
  }

  modal.innerHTML = `
    <div class="progress-modal-content">
      <div class="progress-header">
        <span class="progress-title">Loading...</span>
      </div>
      <div class="progress-body">
        <div class="progress-message">${operationMessage}</div>
        <div class="progress-content">
          <div class="cs-progress-bar" style="flex: 1;">
            <div class="bars" style="width: 1%"></div>
          </div>
          <button class="cs-btn progress-cancel-btn">${cancelText}</button>
        </div>
      </div>
    </div>
  `;

  document.body.appendChild(modal);

  // Add event listener for cancel button
  const cancelBtn = modal.querySelector('.progress-cancel-btn');

  // Store the operation info on the modal for access in the event handler
  modal.operation = {
    remoteName,
    type: operationType,
    cancelled: false
  };

  cancelBtn.addEventListener('click', () => {
    modal.operation.cancelled = true;
    cancelCurrentOperation();
    // Update the modal immediately to show cancellation
    updateProgressModal(modal, 'Cancelled', 'Operation was cancelled', 'OK', 'cancelled');
  });

  // Start the progress bar animation
  animateProgressBar(modal);

  return modal;
}

// Update progress modal
function updateProgressModal(modal, title, message, buttonText, resultType) {
  const titleElement = modal.querySelector('.progress-title');
  const messageElement = modal.querySelector('.progress-message');
  const cancelButton = modal.querySelector('.progress-cancel-btn');
  const progressBar = modal.querySelector('.bars'); // Get the progress bar element (the .bars inside .cs-progress-bar)

  titleElement.textContent = title;
  messageElement.textContent = message;
  cancelButton.textContent = buttonText;

  // Make the progress bar jump to 100% in all scenarios and keep it visible
  if (progressBar) {
    progressBar.style.width = '100%';
  }
  // Mark the operation as completed to stop the animation
  if (modal.operation) {
    modal.operation.completed = true;
  }
  // Keep the progress bar visible - don't hide it in any scenario

  // Add appropriate styling based on result type
  const content = modal.querySelector('.progress-modal-content');
  content.className = 'progress-modal-content'; // Reset class
  content.classList.add(`progress-${resultType}`);

  // Update button functionality - now it just closes the modal
  cancelButton.onclick = () => {
    modal.remove();
  };

  // DO NOT auto-close modal on success - user must close it manually
  // The modal will only auto-close for success after a delay if you want that behavior
  // Currently, we keep the modal open until the user closes it manually
}

// Randomized progress bar simulation - reaches 100% in exactly 10 seconds
function animateProgressBar(modal) {
  const progressBar = modal.querySelector('.bars');
  if (!progressBar) return;

  let progressPercent = 0;
  progressBar.style.width = `${progressPercent}%`;

  // Define random progress increments that will sum to 10 seconds (10000ms)
  // Each step has a delay and a percentage to add to the current progress
  const progressPattern = [
    { percent: 10, delay: 1000 },  // 10% after 1 second
    { percent: 15, delay: 800 },   // 15% more after 800ms (total 25%)
    { percent: 5, delay: 1200 },   // 5% more after 1.2 seconds (total 30%)
    { percent: 20, delay: 1500 },  // 20% more after 1.5 seconds (total 50%)
    { percent: 10, delay: 1000 },  // 10% more after 1 second (total 60%)
    { percent: 15, delay: 2000 },  // 15% more after 2 seconds (total 75%)
    { percent: 15, delay: 1000 },  // 15% more after 1 second (total 90%)
    { percent: 10, delay: 1500 }   // 10% more after 1.5 seconds (total 100%)
  ];  // Total time: 10,000ms (10 seconds)

  let currentProgress = 0;
  let stepIndex = 0;

  // Process each step with delays
  const processStep = () => {
    if (stepIndex >= progressPattern.length || !document.contains(modal) || modal.operation?.cancelled || modal.operation?.completed) {
      return; // Done, cancelled, or completed
    }

    const step = progressPattern[stepIndex];

    setTimeout(() => {
      if (!document.contains(modal) || modal.operation?.cancelled || modal.operation?.completed) {
        return;
      }

      // Update progress to this step
      currentProgress = Math.min(100, currentProgress + step.percent); // Cap at 100%
      progressBar.style.width = `${currentProgress}%`;

      stepIndex++;
      processStep(); // Process next step
    }, step.delay);
  };

  // Start processing steps
  processStep();
}

// Operation cancellation tracking
let operationCancelled = false;

// Cancel current operation
function cancelCurrentOperation() {
  operationCancelled = true;
  console.log("Operation cancellation requested");
}

// Reset cancellation flag
function resetOperationCancellation() {
  operationCancelled = false;
}

// Open settings
async function openSettings() {
  // Create modal div with consistent styling
  const modal = document.createElement('div');
  modal.id = 'settings-modal';
  modal.className = 'progress-modal'; // Use same overlay style as other modals

  const currentTheme = localStorage.getItem('theme') || 'cs16';
  const themeDisplay = currentTheme === 'cs16' ? 'CS 1.6 Steam' : 'CS 1.6 Steam'; // Only one for now

  modal.innerHTML = `
    <div class="progress-modal-content">
      <div class="progress-header">
        <span class="progress-title">Settings</span>
      </div>
      <div class="progress-body">
        <div style="margin: 10px 0;">
          <label class="cs-input__label">Config Path:</label>
          <div style="display: flex; gap: 4px; align-items: center;">
            <input type="text" id="config-path" class="cs-input" style="flex: 1; margin: 4px 0;" value="${localStorage.getItem('rcloneConfigPath') || ''}" placeholder="~/.config/rclone/rclone.conf">
            <button class="cs-btn" id="browse-config-btn" style="white-space: nowrap;">Browse...</button>
          </div>
        </div>
        <div style="margin: 10px 0;">
          <label class="cs-input__label">Theme:</label>
          <div style="margin-top: 4px;">
            
            <!-- Custom Dropdown for Theme -->
            <div class="custom-select-container" id="container-theme-select">
                <div class="custom-select-trigger cs-select" id="trigger-theme-select">${themeDisplay}</div>
                <div class="custom-select-options">
                  <div class="custom-option" data-value="cs16">CS 1.6 Steam</div>
                </div>
                <input type="hidden" id="theme-select" value="${currentTheme}">
            </div>

          </div>
        </div>
        <div class="progress-content" style="justify-content: flex-end; padding-top: 15px;">
          <button class="cs-btn settings-modal-cancel-btn">Cancel</button>
          <button class="cs-btn settings-modal-ok-btn" style="margin-left: 5px;">OK</button>
        </div>
      </div>
    </div>
  `;

  document.body.appendChild(modal);

  // Setup custom dropdown
  setupCustomDropdown('container-theme-select', 'theme-select');

  // Add event listeners for the buttons
  modal.querySelector('.settings-modal-ok-btn').addEventListener('click', () => {
    const newPath = document.getElementById('config-path').value;
    localStorage.setItem('rcloneConfigPath', newPath);
    // Save theme selection
    const themeSelect = document.getElementById('theme-select');
    if (themeSelect) {
      const selectedTheme = themeSelect.value;
      localStorage.setItem('theme', selectedTheme);
    }
    modal.remove();

    // Reload remotes after updating config path
    loadRemotes().catch(error => {
      console.error('Failed to reload remotes after config path update:', error);
      showStatus(`Failed to reload remotes: ${error.message || error}`, 'error');
    });
  });

  modal.querySelector('.settings-modal-cancel-btn').addEventListener('click', () => {
    modal.remove();
  });

  // Add event listener for the browse button
  modal.querySelector('#browse-config-btn').addEventListener('click', async () => {
    try {
      // Use the custom Tauri v2 dialog command
      const fileResponse = await invoke('open_file_dialog', {});

      if (fileResponse) {
        document.getElementById('config-path').value = fileResponse;
      }
    } catch (error) {
      console.error('Error opening file dialog:', error);
      // Show an info message since Tauri dialog may not be available in this context
      showGeneralModal('Info', 'File browsing requires direct Tauri API access. Please enter the path manually.');
    }
  });
}

// Add a new remote
async function addRemote() {
  // First get available plugins to know what types of remotes we can add
  try {
    const plugins = await invoke('get_available_plugins');

    if (plugins.length === 0) {
      showGeneralModal('No Plugins Available', 'No remote plugins available. You can configure remotes using rclone config directly.');
      return;
    }

    // Present user with plugin selection
    // Custom dropdown structure
    let initialValue = plugins[0].name;
    let initialDisplay = plugins[0].display_name;

    let optionsHtml = '';
    plugins.forEach(plugin => {
      optionsHtml += `<div class="custom-option" data-value="${escapeHtml(plugin.name)}">${escapeHtml(plugin.display_name)}</div>`;
    });

    const addRemoteHtml = `
      <div class="progress-modal-content">
        <div class="progress-header">
          <span class="progress-title">Add New Remote</span>
        </div>
        <div class="progress-body">
          <div style="margin: 10px 0;">
            <label class="cs-input__label">Remote Type:</label>
            <div style="margin-top: 4px;">
              
              <!-- Custom Dropdown -->
              <div class="custom-select-container" id="container-remote-type">
                <div class="custom-select-trigger cs-select" id="trigger-remote-type">${escapeHtml(initialDisplay)}</div>
                <div class="custom-select-options">
                  ${optionsHtml}
                </div>
                <input type="hidden" id="remote-type" value="${escapeHtml(initialValue)}">
              </div>

            </div>
          </div>
          <div style="margin: 10px 0;">
            <label class="cs-input__label">Remote Name:</label>
            <div style="margin-top: 4px;">
              <input type="text" id="remote-name" class="cs-input" placeholder="Enter remote name" style="width: 100%;">
            </div>
          </div>
          <div style="margin: 10px 0; height: 300px; overflow-y: auto; border: 1px solid var(--border-dark); padding: 10px; max-height: 300px;">
            <div id="plugin-fields">
              <!-- Plugin-specific fields will be loaded here -->
            </div>
          </div>
          <div class="progress-content" style="justify-content: flex-end; padding-top: 15px;">
            <button class="cs-btn cancel-remote-btn">Cancel</button>
            <button class="cs-btn submit-remote-btn" style="margin-left: 5px;">Add Remote</button>
          </div>
        </div>
      </div>
    `;

    // Create modal div
    const modal = document.createElement('div');
    modal.id = 'add-remote-modal';
    modal.className = 'progress-modal'; // Use same class as other modals
    modal.innerHTML = addRemoteHtml;

    document.body.appendChild(modal);

    // Setup Custom Dropdown Logic
    setupCustomDropdown('container-remote-type', 'remote-type');

    // When a remote type is selected, load its specific fields (now listening on hidden input)
    document.getElementById('remote-type').addEventListener('change', async function () {
      const selectedPluginName = this.value;
      const plugins = await invoke('get_available_plugins');
      const selectedPlugin = plugins.find(p => p.name === selectedPluginName);

      if (selectedPlugin) {
        let fieldsHtml = '<div style="margin-top: 10px;"><h4 class="cs-input__label">Basic Configuration:</h4>';

        // Display basic fields
        const basicFields = selectedPlugin.basic_fields || selectedPlugin.fields || [];
        basicFields.forEach(field => {
          fieldsHtml += `
            <div style="margin: 8px 0;">
              <label class="cs-input__label">${escapeHtml(field.display_name)}${field.required ? ' *' : ''}:</label>
              ${buildFieldHtml(field, field.default ?? '')}
            </div>
          `;
        });

        // Add advanced fields toggle
        if (selectedPlugin.advanced_fields && selectedPlugin.advanced_fields.length > 0) {
          fieldsHtml += `<div style="margin: 15px 0;"><button id="toggle-advanced-fields" class="cs-btn">Show Advanced Options</button></div>`;

          // Initially hide advanced fields
          fieldsHtml += `<div id="advanced-fields-container" style="display: none; margin-top: 15px; padding-top: 10px; border-top: 1px solid var(--border-dark);">`;
          fieldsHtml += `<h4 class="cs-input__label">Advanced Configuration:</h4>`;

          selectedPlugin.advanced_fields.forEach(field => {
            fieldsHtml += `
              <div style="margin: 8px 0;">
                <label class="cs-input__label">${escapeHtml(field.display_name)}${field.required ? ' *' : ''}:</label>
                ${buildFieldHtml(field, field.default ?? '')}
              </div>
            `;
          });
          fieldsHtml += `</div>`;
        }

        fieldsHtml += '</div>';
        document.getElementById('plugin-fields').innerHTML = fieldsHtml;
        bindFileBrowseButtons(document.getElementById('plugin-fields'));

        // Add event listener for advanced fields toggle
        const toggleButton = document.getElementById('toggle-advanced-fields');
        if (toggleButton) {
          toggleButton.addEventListener('click', function () {
            const container = document.getElementById('advanced-fields-container');
            if (container.style.display === 'none') {
              container.style.display = 'block';
              this.textContent = 'Hide Advanced Options';
            } else {
              container.style.display = 'none';
              this.textContent = 'Show Advanced Options';
            }
          });
        }
      }
    });

    // Add event listener for submit button
    let addCancelled = false;
    const submitBtn = document.querySelector('.submit-remote-btn');
    submitBtn.addEventListener('click', async function () {
      if (this.disabled) return;
      const remoteType = document.getElementById('remote-type').value;
      const remoteName = document.getElementById('remote-name').value.trim();

      if (!remoteName) {
        showGeneralModal('Error', 'Please enter a remote name');
        return;
      }

      // Get plugin to see what fields are needed
      const plugins = await invoke('get_available_plugins');
      const plugin = plugins.find(p => p.name === remoteType);
      if (!plugin) {
        showGeneralModal('Error', 'Invalid plugin selected');
        return;
      }

      // Build the config object from the input fields
      const config = { remote_name: remoteName };

      // Add values for each required field
      const allFields = [...(plugin.basic_fields || plugin.fields || []), ...(plugin.advanced_fields || [])];
      allFields.forEach(field => {
        const element = document.getElementById(`field-${field.name}`);
        if (!element) return;
        // Handle checkbox differently
        if (field.type === 'checkbox') {
          config[field.name] = element.checked ? 'true' : 'false';
          return;
        }
        // Skip unset fields (no input, no default) — never write 'undefined'
        const value = element.value || field.default;
        if (value !== undefined && value !== '') {
          config[field.name] = value;
        }
      });

      const configPath = localStorage.getItem('rcloneConfigPath') || null;
      this.disabled = true;
      const originalLabel = this.textContent;
      this.textContent = 'Adding...';

      try {
        const result = await invoke('add_remote_with_plugin', {
          pluginName: remoteType,
          config: config,
          configPathOpt: configPath
        });

        if (!result.success) {
          showGeneralModal('Failed to add remote', result.message);
          return;
        }

        if (addCancelled) {
          await rollbackNewRemote(remoteName, configPath);
          return;
        }

        showStatus('Added remote. Testing connection...', 'info');

        let testResult;
        try {
          testResult = await Promise.race([
            invoke('test_connection', { remoteName, configPathOpt: configPath }),
            new Promise((_, reject) => setTimeout(
              () => reject(new Error('Connection test timed out after 15 seconds')), 15000
            ))
          ]);
        } catch (testError) {
          testResult = { success: false, message: testError.message || 'Connection test failed' };
        }

        // If the user cancelled while the test was running, remove the new remote.
        if (addCancelled) {
          await rollbackNewRemote(remoteName, configPath);
          return;
        }

        if (testResult.success) {
          showGeneralModal('Success', `Remote added and connection tested successfully!\n${testResult.message}`);
          document.getElementById('add-remote-modal')?.remove();
          await loadRemotes(); // Refresh the list
          return;
        }

        const shouldSaveAnyway = confirm(
          `${testResult.message}\n\n` +
          `Do you want to keep the remote configuration anyway?\n\n` +
          `Click OK to keep the remote configuration despite the connection failure.\n` +
          `Click Cancel to remove it and stay to make changes.`
        );

        if (shouldSaveAnyway) {
          showGeneralModal('Remote Saved', `Remote added with connection test failure.\n${testResult.message}`);
          document.getElementById('add-remote-modal')?.remove();
          await loadRemotes(); // Refresh the list
        } else {
          // The remote is written before the test; remove it when the user declines.
          const removed = await rollbackNewRemote(remoteName, configPath);
          showStatus(
            removed ? 'Connection test failed. The remote was not saved.'
              : 'Connection test failed, and the new remote could not be removed.',
            'warning'
          );
        }
      } catch (error) {
        console.error('Error adding remote:', error);
        showGeneralModal('Error', `Failed to add remote: ${escapeHtml(stripErrorCode(cleanIpcError(error)))}`);
      } finally {
        if (document.contains(this)) {
          this.disabled = false;
          this.textContent = originalLabel;
        }
      }
    });

    // Add event listener for cancel button
    document.querySelector('.cancel-remote-btn').addEventListener('click', () => {
      addCancelled = true;
      document.getElementById('add-remote-modal')?.remove();
    });

    // Trigger the change event to load fields for the default selection
    document.getElementById('remote-type').dispatchEvent(new Event('change'));
  } catch (error) {
    console.error('Error getting plugins:', error);
    showGeneralModal('Error', 'Error getting remote types: ' + error.message);
  }
}

// Debug test function
async function debugTest() {
  try {
    showGeneralModal('Debug Test', 'Hello World! Debug test successful.');
  } catch (error) {
    console.error('Debug test error:', error);
    showGeneralModal('Debug Error', `Debug test failed: ${error.message}`);
  }
}

// Show config path function
async function showConfigPath() {
  try {
    showGeneralModal('Config Path Info', 'Expected config path: ~/.config/rclone/rclone.conf');
  } catch (error) {
    console.error('Config path error:', error);
    showGeneralModal('Config Path Error', `Error showing config path: ${error.message}`);
  }
}

// Show general purpose modal dialog
function showGeneralModal(title, message, buttonText = 'OK', resultType = 'info') {
  // Create modal div
  const modal = document.createElement('div');
  modal.id = 'general-modal';
  modal.className = 'progress-modal'; // Use same overlay style as progress modal

  modal.innerHTML = `
    <div class="progress-modal-content">
      <div class="progress-header">
        <span class="progress-title">${title}</span>
      </div>
      <div class="progress-body">
        <div class="progress-message">${message}</div>
        <div class="progress-content" style="justify-content: flex-end; padding-top: 10px;">
          <button class="cs-btn general-modal-btn">${buttonText}</button>
        </div>
      </div>
    </div>
  `;

  document.body.appendChild(modal);

  // Add event listener for the button
  const okBtn = modal.querySelector('.general-modal-btn');
  okBtn.addEventListener('click', () => {
    modal.remove();
  });

  return modal;
}

// Function to show a CS confirmation modal
function showConfirmModal(title, message, onConfirm) {
  const modal = document.createElement('div');
  modal.className = 'progress-modal';

  modal.innerHTML = `
    <div class="progress-modal-content">
      <div class="progress-header">
        <span class="progress-title">${title}</span>
      </div>
      <div class="progress-body">
        <div class="progress-message">${message.replace(/\n/g, '<br>')}</div>
        <div class="progress-content" style="justify-content: flex-end; padding-top: 10px;">
          <button class="cs-btn" id="confirm-cancel-btn" style="margin-right: 5px;">Cancel</button>
          <button class="cs-btn" id="confirm-ok-btn">OK</button>
        </div>
      </div>
    </div>
  `;

  document.body.appendChild(modal);

  const cancelBtn = modal.querySelector('#confirm-cancel-btn');
  const okBtn = modal.querySelector('#confirm-ok-btn');

  const closeModal = () => {
    modal.remove();
  };

  cancelBtn.addEventListener('click', closeModal);

  okBtn.addEventListener('click', () => {
    closeModal();
    if (onConfirm) onConfirm();
  });
}

// Create context menu for remote
function createContextMenu(x, y, remote) {
  // Remove any existing context menu
  const existingMenu = document.getElementById('context-menu');
  if (existingMenu) {
    existingMenu.remove();
  }

  // Create context menu container
  const menu = document.createElement('div');
  menu.id = 'context-menu';
  menu.className = 'progress-modal-content'; // Use same styling as other modals
  menu.style.position = 'fixed';
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';
  menu.style.zIndex = '10000';
  menu.style.boxShadow = '5px 5px 0px rgba(0,0,0,0.2)'; // CS 1.6 style shadow
  menu.style.minWidth = '200px';
  menu.style.maxWidth = '250px';

  // Determine cron action
  const isCron = remote.cron === "Yes";
  const cronAction = isCron ? "Disable auto-mount" : "Enable auto-mount";
  const cronIcon = isCron ? '<img src="cron_icon.svg" style="width: 16px; height: 16px; vertical-align: bottom; margin-right: 8px;">' : '<img src="cron_icon.svg" style="width: 16px; height: 16px; vertical-align: bottom; margin-right: 8px; opacity: 0.5;">';

  // Create menu content with proper CS16 styling
  menu.innerHTML = `
    <div class="progress-body" style="padding: 5px 0;">
      <div class="context-menu-item cs-btn" id="menu-cron" style="display: block; text-align: left; padding: 8px 12px; margin: 0; width: 100%; text-decoration: none; background-color: var(--bg); border: 1px solid var(--border-light) var(--border-dark) var(--border-dark) var(--border-light); cursor: pointer;"
           onmouseover="this.style.backgroundColor='var(--secondary-accent)'; this.style.color='black'"
           onmouseout="this.style.backgroundColor='var(--bg)'; this.style.color='var(--text)'">
        ${cronIcon}${cronAction}
      </div>
      <div class="context-menu-item cs-btn" id="menu-edit" style="display: block; text-align: left; padding: 8px 12px; margin: 0; width: 100%; text-decoration: none; background-color: var(--bg); border: 1px solid var(--border-light) var(--border-dark) var(--border-dark) var(--border-light); cursor: pointer;"
           onmouseover="this.style.backgroundColor='var(--secondary-accent)'; this.style.color='black'"
           onmouseout="this.style.backgroundColor='var(--bg)'; this.style.color='var(--text)'">
        <img src="edit_icon.svg" style="width: 16px; height: 16px; vertical-align: bottom; margin-right: 8px;">Edit
      </div>
      <div class="context-menu-item cs-btn" id="menu-delete" style="display: block; text-align: left; padding: 8px 12px; margin: 0; width: 100%; text-decoration: none; background-color: var(--bg); border: 1px solid var(--border-light) var(--border-dark) var(--border-dark) var(--border-light); cursor: pointer;"
           onmouseover="this.style.backgroundColor='var(--secondary-accent)'; this.style.color='black'"
           onmouseout="this.style.backgroundColor='var(--bg)'; this.style.color='var(--text)'">
        <img src="delete_icon.svg" style="width: 16px; height: 16px; vertical-align: bottom; margin-right: 8px;">Delete
      </div>
    </div>
  `;

  document.body.appendChild(menu);

  // Add event listeners to menu items
  document.getElementById('menu-cron').addEventListener('click', async () => {
    menu.remove();
    try {
      const action = isCron ? 'remove_from_cron' : 'add_to_cron';
      const configPath = localStorage.getItem('rcloneConfigPath') || null;

      showStatus(isCron ? "Disabling auto-mount..." : "Enabling auto-mount...", 'info');

      const result = await invoke(action, {
        remoteName: remote.name,
        configPathOpt: configPath
      });

      if (result.success) {
        showStatus(result.message, 'success');
        await loadRemotes(); // Refresh table to show updated status
      } else {
        showGeneralModal('Error', result.message);
      }
    } catch (e) {
      showGeneralModal('Error', `Operation failed: ${e.message || e}`);
    }
  });

  document.getElementById('menu-edit').addEventListener('click', () => {
    handleEditRemote(remote);
    menu.remove();
  });

  document.getElementById('menu-delete').addEventListener('click', () => {
    handleDeleteRemote(remote);
    menu.remove();
  });

  // Close menu when clicking elsewhere
  const closeMenu = () => {
    menu.remove();
    document.removeEventListener('click', closeMenu);
  };

  // Add a small delay to allow the menu to be clicked before registering document clicks
  setTimeout(() => {
    document.addEventListener('click', closeMenu);
  }, 100);
}

// Handle editing a remote
async function handleEditRemote(remote) {
  try {
    // Get available plugins to find one that matches this remote type
    const plugins = await invoke('get_available_plugins');

    // Find a plugin that matches this remote type
    // Look for exact match first (more reliable)
    let plugin = plugins.find(p => p.name.toLowerCase() === remote.type.toLowerCase());

    // If no exact match, try matching in display name - but with exact match, not partial
    if (!plugin) {
      plugin = plugins.find(p => p.display_name.toLowerCase() === remote.type.toLowerCase());
    }

    if (!plugin) {
      showGeneralModal('Cannot Edit', `Cannot edit remote '${remote.name}'. No plugin found for type '${remote.type}'.`);
      return;
    }

    // Get the current configuration for this remote
    const configPath = localStorage.getItem('rcloneConfigPath') || null;
    const remoteConfig = await invoke('get_remote_config', {
      remoteName: remote.name,
      configPathOpt: configPath
    });

    // Now we have the plugin and remote config, so call a new function to open the edit form
    await openEditRemoteForm(remote, plugin, remoteConfig);
  } catch (error) {
    console.error('Error editing remote:', error);
    if (error.message?.includes("not found in config")) {
      showGeneralModal('Error', `Remote '${remote.name}' not found in the config file anymore.`);
    } else {
      showGeneralModal('Error', `Failed to edit remote: ${escapeHtml(stripErrorCode(cleanIpcError(error)))}`);
    }
  }
}

// Function to open the remote editing form
async function openEditRemoteForm(remote, plugin, remoteConfig) {
  // Create modal HTML for editing remote
  const modal = document.createElement('div');
  modal.id = 'edit-remote-modal';
  modal.className = 'progress-modal'; // Use same styling as other modals

  // Build plugin options for dropdown
  let pluginOptions = '';
  const plugins = await invoke('get_available_plugins');
  plugins.forEach(p => {
    const selected = p.name === plugin.name ? 'selected' : '';
    pluginOptions += `<option value="${escapeHtml(p.name)}" ${selected}>${escapeHtml(p.display_name)}</option>`;
  });

  // Create the HTML for the edit form
  modal.innerHTML = `
    <div class="progress-modal-content">
      <div class="progress-header">
        <span class="progress-title">Edit Remote: ${escapeHtml(remote.name)}</span>
      </div>
      <div class="progress-body">
        <div style="margin: 10px 0;">
          <label class="cs-input__label">Remote Name:</label>
          <div style="margin-top: 4px;">
            <input type="text" id="remote-name" class="cs-input" value="${escapeHtml(remote.name)}" style="width: 100%;">
          </div>
        </div>
        <div style="margin: 10px 0;">
          <label class="cs-input__label">Remote Type:</label>
          <div style="margin-top: 4px;">
            <select id="remote-type" class="cs-select" style="width: 100%;" disabled>
              ${pluginOptions}
            </select>
          </div>
        </div>
        <div style="margin: 10px 0; height: 300px; overflow-y: auto; border: 1px solid var(--border-dark); padding: 10px; max-height: 300px;">
          <div id="plugin-fields">
            <!-- Plugin-specific fields will be loaded here with current values -->
          </div>
        </div>
        <div class="progress-content" style="justify-content: flex-end; padding-top: 15px;">
          <button class="cs-btn cancel-edit-btn">Cancel</button>
          <button class="cs-btn save-edit-btn" style="margin-left: 5px;">Save Changes</button>
        </div>
      </div>
    </div>
  `;

  document.body.appendChild(modal);

  // Fill in the plugin fields with current values
  loadPluginFieldsForEdit(plugin, remoteConfig);

  // Add event listeners for the buttons
  modal.querySelector('.cancel-edit-btn').addEventListener('click', () => {
    document.getElementById('edit-remote-modal')?.remove();
  });

  const saveBtn = modal.querySelector('.save-edit-btn');
  saveBtn.addEventListener('click', async () => {
    if (saveBtn.disabled) return;
    const newName = document.getElementById('remote-name').value.trim();
    const newType = document.getElementById('remote-type').value;

    // Build config object from field values. Unchanged secrets and file paths
    // are omitted so the backend keeps their stored values.
    const config = { remote_name: newName };
    const allFields = [...(plugin.basic_fields || plugin.fields || []), ...(plugin.advanced_fields || [])];
    allFields.forEach(field => {
      const element = document.getElementById(`field-${field.name}`);
      if (!element) return;
      if (field.type === 'checkbox') {
        config[field.name] = element.checked ? 'true' : 'false';
        return;
      }
      const value = element.value;
      if ((field.type === 'password' || field.type === 'file') && value === '') return;
      config[field.name] = value;
    });

    const configPath = localStorage.getItem('rcloneConfigPath') || null;
    saveBtn.disabled = true;
    const originalLabel = saveBtn.textContent;
    saveBtn.textContent = 'Saving...';

    try {
      const result = await invoke('update_remote_with_plugin', {
        remoteName: remote.name,
        pluginName: newType,
        config: config,
        configPathOpt: configPath
      });
      showGeneralModal('Success', result.message || `Remote '${newName}' updated successfully!`);
      document.getElementById('edit-remote-modal')?.remove();
      await loadRemotes(); // Refresh the list
    } catch (error) {
      console.error('Error updating remote:', error);
      showGeneralModal('Error', `Failed to update remote: ${escapeHtml(stripErrorCode(cleanIpcError(error)))}`);
    } finally {
      if (document.contains(saveBtn)) {
        saveBtn.disabled = false;
        saveBtn.textContent = originalLabel;
      }
    }
  });
}

// Function to load plugin fields with current values for editing
function loadPluginFieldsForEdit(plugin, remoteConfig) {
  let fieldsHtml = '<div style="margin-top: 10px;"><h4 class="cs-input__label">Configuration Fields:</h4>';

  const renderField = (field) => {
    // Honour legacy aliases (e.g. the old "concurreny" typo) when present.
    const legacyValue = (field.legacy_names || [])
      .map(name => remoteConfig[name])
      .find(value => value !== undefined);
    // Never expose stored secrets in the form; an empty value means "keep existing".
    const value = field.type === 'password'
      ? ''
      : (remoteConfig[field.name] ?? legacyValue ?? field.default ?? '');
    return `
      <div style="margin: 8px 0;">
        <label class="cs-input__label">${escapeHtml(field.display_name)}${field.required ? ' *' : ''}:</label>
        ${buildFieldHtml(field, value)}
      </div>
    `;
  };

  (plugin.basic_fields || plugin.fields || []).forEach(field => {
    fieldsHtml += renderField(field);
  });

  if (plugin.advanced_fields && plugin.advanced_fields.length > 0) {
    fieldsHtml += `<div style="margin: 15px 0;"><button id="toggle-advanced-fields" class="cs-btn">Show Advanced Options</button></div>`;
    fieldsHtml += `<div id="advanced-fields-container" style="display: none; margin-top: 15px; padding-top: 10px; border-top: 1px solid var(--border-dark);">`;
    fieldsHtml += `<h4 class="cs-input__label">Advanced Configuration:</h4>`;
    plugin.advanced_fields.forEach(field => {
      fieldsHtml += renderField(field);
    });
    fieldsHtml += `</div>`;
  }

  fieldsHtml += '</div>';
  const container = document.getElementById('plugin-fields');
  container.innerHTML = fieldsHtml;
  bindFileBrowseButtons(container);

  const toggleButton = document.getElementById('toggle-advanced-fields');
  if (toggleButton) {
    toggleButton.addEventListener('click', function () {
      const advanced = document.getElementById('advanced-fields-container');
      if (!advanced) return;
      if (advanced.style.display === 'none') {
        advanced.style.display = 'block';
        this.textContent = 'Hide Advanced Options';
      } else {
        advanced.style.display = 'none';
        this.textContent = 'Show Advanced Options';
      }
    });
  }
}

// Handle deleting a remote
async function handleDeleteRemote(remote) {
  showConfirmModal('Delete Remote', `Delete remote '${escapeHtml(remote.name)}'?\n\nThis will unmount its managed mount and disable auto-mount before removing its configuration. If cleanup fails, the configuration is kept so you can retry.\n\nThis action cannot be undone.`, async () => {
    try {
      // Get the config path from localStorage or use default (null)
      const configPath = localStorage.getItem('rcloneConfigPath') || null;

      // Call the backend to delete the remote
      const result = await invoke('delete_remote', {
        remoteName: remote.name,
        configPathOpt: configPath
      });

      if (result.success) {
        showGeneralModal('Success', result.message);
        // Reload remotes to reflect the change
        await loadRemotes();
      } else {
        showGeneralModal('Error', result.message);
      }
    } catch (error) {
      console.error('Error deleting remote:', error);
      showGeneralModal('Error', `Failed to delete remote: ${escapeHtml(stripErrorCode(cleanIpcError(error)))}`);
    }
  });
}

// Export functions for Tauri commands to use if needed
window.rcloneManager = {
  loadRemotes,
  showStatus
};
// Helper to setup custom dropdown behavior
function setupCustomDropdown(containerId, hiddenInputId, onChangeCallback) {
  const container = document.getElementById(containerId);
  if (!container) return;

  const trigger = container.querySelector('.custom-select-trigger');
  const optionsContainer = container.querySelector('.custom-select-options');
  const hiddenInput = document.getElementById(hiddenInputId);
  const options = container.querySelectorAll('.custom-option');

  if (!trigger || !optionsContainer || !hiddenInput) return;

  // Toggle dropdown
  trigger.addEventListener('click', (e) => {
    e.stopPropagation();
    // Close other open dropdowns
    document.querySelectorAll('.custom-select-options').forEach(el => {
      if (el !== optionsContainer) el.classList.remove('show');
    });
    optionsContainer.classList.toggle('show');
  });

  // Handle option selection
  options.forEach(option => {
    option.addEventListener('click', (e) => {
      e.stopPropagation();
      trigger.textContent = option.textContent;
      const newVal = option.getAttribute('data-value');

      if (hiddenInput.value !== newVal) {
        hiddenInput.value = newVal;
        // Dispatch change event manually for compatibility
        hiddenInput.dispatchEvent(new Event('change'));

        if (onChangeCallback) {
          onChangeCallback(newVal);
        }
      }
      optionsContainer.classList.remove('show');
    });
  });

  // Close when clicking outside
  const closeListener = (e) => {
    if (!document.body.contains(container)) {
      window.removeEventListener('click', closeListener);
      return;
    }
    if (!container.contains(e.target)) {
      optionsContainer.classList.remove('show');
    }
  };
  window.addEventListener('click', closeListener);
}
