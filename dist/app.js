// Rclone Manager - Tauri v2 API Interface
// Global variables for Tauri functions
let invoke, dialog;

// DOM elements
let remoteTableBody, mountBtn, unmountBtn, openBtn, refreshBtn, testBtn, addRemoteBtn, configPathBtn, statusText, settingsBtn;

// Currently selected remote
let selectedRemote = null;

// Operation tracking to prevent multiple simultaneous operations
let isOperationInProgress = false;

// Initialize the app when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
  console.log("Rclone Manager: Initializing app...");

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

  // Load remotes
  loadRemotes().catch(error => {
    console.error('Failed to load remotes:', error);
    showStatus(`Failed to load remotes: ${error.message}`, 'error');
  });
});

// Initialize Tauri API functions properly for v2
function initializeTauriAPI() {
  // Tauri v2 uses global APIs that are available in the window object
  if (window.__TAURI_INVOKE__) {
    console.log("Tauri v2 API available via __TAURI_INVOKE__");
    invoke = window.__TAURI_INVOKE__;
  } else if (typeof window.tauri !== 'undefined' && window.tauri.invoke) {
    // Alternative Tauri v2 approach
    console.log("Tauri API available via window.tauri");
    invoke = window.tauri.invoke;
  } else if (window.__TAURI_INTERNALS__?.invoke) {
    console.log("Tauri API available via __TAURI_INTERNALS__");
    invoke = window.__TAURI_INTERNALS__.invoke;
  } else {
    console.error("Tauri APIs not found in global scope!");
    console.log("Available globals:", Object.keys(window).filter(key => key.includes('TAURI')));

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

    renderRemotesTable(remotes);
    const message = `Loaded ${remotes.length} remotes`;
    defaultStatusMessage = message; // Update the default message
    showStatus(message, 'success', false); // Don't auto-reset the loaded message
  } catch (error) {
    console.error('Error loading remotes:', error);
    // Handle error safely to avoid undefined error.message
    const errorMessage = error && typeof error === 'object' && error.message ? error.message : String(error);
    const displayMessage = `Error loading remotes: ${errorMessage}`;
    // Don't reset defaultStatusMessage if it's the config not found specific message
    if (!errorMessage.includes("rclone.conf not found")) {
      defaultStatusMessage = "Ready"; // Reset to ready state on other errors
    }
    showStatus(displayMessage, 'error');

    // Specific error message for common issues
    if (errorMessage && errorMessage.includes("rclone.conf not found")) {
      showStatus("rclone.conf not found. Select it from settings or add a new remote to create it.", 'warning', false); // Yellow and doesn't auto-reset
      defaultStatusMessage = "rclone.conf not found. Select it from settings or add a new remote to create it."; // Keep this as the persistent message
    } else if (errorMessage && errorMessage.includes("Failed to read config")) {
      showStatus("Could not read rclone config. Check ~/.config/rclone/rclone.conf", 'warning', false); // Yellow and doesn't auto-reset
    }
  }
}

// Function to render remotes in the table
function renderRemotesTable(remotes) {
  if (!remoteTableBody) {
    console.error("remoteTableBody element not found");
    return;
  }

  remoteTableBody.innerHTML = '';

  // Update the header to show the count
  updateRemoteHeader(remotes?.length || 0);

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

// Function to update the header with remote count
function updateRemoteHeader(count) {
  const headerRow = document.querySelector('#remote-table thead tr');
  if (headerRow) {
    // Get the existing header cells to preserve other columns
    const currentHeaders = headerRow.querySelectorAll('th');
    if (currentHeaders.length >= 5) {
      // Update only the first header (Remote) with the count
      currentHeaders[0].textContent = `Remotes (${count})`;
    }
  }
}

// Function to update button states based on selected remote
function updateButtonStates(remote) {
  // Reset all buttons to disabled initially
  if (mountBtn) mountBtn.disabled = true;
  if (unmountBtn) unmountBtn.disabled = true;
  if (openBtn) openBtn.disabled = true;
  if (testBtn) testBtn.disabled = true;

  // Only enable buttons if a remote is selected
  if (remote) {
    if (mountBtn) mountBtn.disabled = remote.mounted === 'Yes';
    if (unmountBtn) unmountBtn.disabled = remote.mounted !== 'Yes';
    if (openBtn) openBtn.disabled = remote.mounted !== 'Yes';
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
    // Create a timeout promise that rejects after 10 seconds to match test connection timeout
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('Mount operation timed out after 10 seconds')), 10000);
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
  resetOperationCancellation(); // Reset cancellation flag

  // Show progress modal with cancel button
  const modal = showProgressDialog(`Unmounting ${remoteName}...`, 'Cancel', remoteName, 'unmount');

  try {
    // Create a timeout promise that rejects after 10 seconds to match test connection timeout
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('Unmount operation timed out after 10 seconds')), 10000);
    });

    // Get the config path from localStorage or use default (null)
    const configPath = localStorage.getItem('rcloneConfigPath') || null;
    // Race the invoke call with the timeout
    const result = await Promise.race([
      invoke('unmount_remote', { remoteName, configPathOpt: configPath }),
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
    // Create a timeout promise that rejects after 10 seconds
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('Test connection timed out after 10 seconds')), 10000);
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
        <fieldset class="cs-fieldset" style="margin: 10px 0;">
          <legend class="cs-input__label">Theme:</legend>
          <div style="margin-top: 4px;">
            <input type="radio" id="theme-cs16" name="theme" value="cs16" ${localStorage.getItem('theme') === 'cs16' ? 'checked' : ''}>
            <label for="theme-cs16">CS 1.6 Steam</label>
          </div>
        </fieldset>
        <div class="progress-content" style="justify-content: flex-end; padding-top: 15px;">
          <button class="cs-btn settings-modal-cancel-btn">Cancel</button>
          <button class="cs-btn settings-modal-ok-btn" style="margin-left: 5px;">OK</button>
        </div>
      </div>
    </div>
  `;

  document.body.appendChild(modal);

  // Add event listeners for the buttons
  modal.querySelector('.settings-modal-ok-btn').addEventListener('click', () => {
    const newPath = document.getElementById('config-path').value;
    localStorage.setItem('rcloneConfigPath', newPath);
    // Save theme selection if needed
    const selectedThemeElement = document.querySelector('input[name="theme"]:checked');
    if (selectedThemeElement) {
      const selectedTheme = selectedThemeElement.value;
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
          <button class="cs-btn" id="submit-remote-btn">Add Remote</button>
          <button class="cs-btn" id="cancel-remote-btn" style="margin-left: 5px;">Cancel</button>
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

    // When a remote type is selected, load its specific fields
    document.getElementById('remote-type').addEventListener('change', async function() {
      const selectedPluginName = this.value;
      const plugins = await invoke('get_available_plugins');
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

    // Add event listener for submit button
    document.getElementById('submit-remote-btn').addEventListener('click', async function() {
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
      plugin.fields.forEach(field => {
        const element = document.getElementById(`field-${field.name}`);
        if (element) {
          // Handle checkbox differently 
          if (field.field_type === 'checkbox') {
            config[field.name] = element.checked ? 'true' : 'false';
          } else {
            config[field.name] = element.value || field.default;
          }
        }
      });

      try {
        // Get the config path from localStorage or use default (null)
        const configPath = localStorage.getItem('rcloneConfigPath') || null;
        const result = await invoke('add_remote_with_plugin', {
          pluginName: remoteType,
          config: config,
          configPathOpt: configPath
        });

        if (result.success) {
          showGeneralModal('Success', result.message);
          document.getElementById('add-remote-modal').remove();
          await loadRemotes(); // Refresh the list
        } else {
          showGeneralModal('Failed', result.message);
        }
      } catch (error) {
        console.error('Error adding remote:', error);
        showGeneralModal('Error', `Failed to add remote: ${error.message}`);
      }
    });

    // Add event listener for cancel button
    document.getElementById('cancel-remote-btn').addEventListener('click', () => {
      document.getElementById('add-remote-modal').remove();
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

// Export functions for Tauri commands to use if needed
window.rcloneManager = {
  loadRemotes,
  showStatus
};