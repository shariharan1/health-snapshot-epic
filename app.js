// ==========================
// CONFIGURATION
// ==========================
let _config = null;
async function getConfig() {
    if (_config) return _config;
    try {
        const response = await fetch('config.json');
        if (!response.ok) {
            throw new Error(`HTTP ${response.status} when fetching config`);
        }
        _config = await response.json();
    } catch (e) {
        console.error("Failed to load config.json", e);
        _config = {};
    }
    return _config;
}

var client_session = null;
var session_timer_id = null;

let isEhrRedirecting = false;
let isEhrLaunch = false;
let endpointConfig = null;
let endpointName = null;

const isRedirect = new URLSearchParams(window.location.search).has("code");

//const marked = window.markdownit();

let dbug = true;

function debug(str) {
    if (dbug) {
        console.log(str);
    }
}


// ==========================
// LOGIN HANDLER/HELPERS 
// ==========================

function scheduleTokenRefresh(client, expiresInSeconds) {

    debug("Entering scheduleTokenRefresh...");

    if (session_timer_id !== null) {
        clearTimeout(session_timer_id);
    }

    // Refresh 60 seconds before it officially expires. 
    // If lifetime is somehow under 60 seconds, refresh at half its lifetime.
    const bufferSeconds = Math.min(60, Math.floor(expiresInSeconds / 2));
    const timeoutMs = Math.max(0, (expiresInSeconds - bufferSeconds)) * 1000;

    debug(`Scheduling background refresh in ${timeoutMs / 1000} seconds...`);

    session_timer_id = setTimeout(async () => {
        debug('Background timer triggered. Attempting client.refresh()...');
        try {
            await client.refresh();
            const newResp = client.state.tokenResponse;
            const newExpiresAt = Date.now() + (newResp.expires_in * 1000);
            localStorage.setItem('fhir_token_expires', newExpiresAt);
            debug('Refresh successful! New expiry time: ' + new Date(newExpiresAt).toLocaleString());

            // Loop back and schedule the next refresh
            scheduleTokenRefresh(client, newResp.expires_in);
        } catch (error) {
            console.warn("Background session refresh failed!", error);
            resetToLogin("Token refresh failed! Please sign in again.", "error");
        }
    }, timeoutMs);

    debug("Exiting scheduleTokenRefresh!");
}

function resetToLogin(strMsg = null, msgType = null) {
    debug("Resetting to login state...");
    client_session = null;

    // Clear underlying FHIR client session storage
    sessionStorage.clear();
    localStorage.removeItem('fhir_token_expires');

    // Remove OAuth redirect params (code, state) from URL to prevent automatic re-login on refresh
    if (window.history && window.history.replaceState) {
        const cleanUrl = window.location.protocol + "//" + window.location.host + window.location.pathname;
        window.history.replaceState({}, document.title, cleanUrl);
    }

    document.getElementById("curr_sandbox")?.classList.add("hidden");
    document.getElementById("logout-section")?.classList.add("hidden");
    document.getElementById("app-content")?.classList.add("hidden");

    if (!isEhrRedirecting) {
        document.getElementById("login-section")?.classList.remove("hidden");

        const fhirEndpoint = document.getElementById("fhir-endpoint");
        if (fhirEndpoint) {
            const changeEvent = new Event('change', { bubbles: true });
            fhirEndpoint.dispatchEvent(changeEvent);
        }
    }

    if (session_timer_id !== null) {
        clearTimeout(session_timer_id);
        session_timer_id = null;
    }

    if (strMsg !== null) {
        showAlert(strMsg, msgType);
    }
}

async function populateEndpoints() {
    const config = await getConfig();
    const select = document.getElementById("fhir-endpoint");
    const desc = document.getElementById("endpoint-desc");
    const loginBtn = document.getElementById("login-btn");

    if (!select) return;

    select.innerHTML = "";

    for (const [key, endpoint] of Object.entries(config.fhir_endpoints)) {
        const option = document.createElement("option");
        option.value = key;
        option.textContent = endpoint.name || key;
        select.appendChild(option);
    }

    select.addEventListener("change", (e) => {
        const selectedKey = e.target.value;
        const endpoint = config.fhir_endpoints[selectedKey];
        if (endpoint) {
            desc.textContent = endpoint.description || "";
            loginBtn.textContent = `Sign in with ${endpoint.name || selectedKey}`;
        }
    });

    const savedEndpoint = localStorage.getItem('selected_fhir_endpoint');
    if (savedEndpoint && config.fhir_endpoints[savedEndpoint]) {
        select.value = savedEndpoint;
    }

    const savedRefreshPref = localStorage.getItem('enable_refresh_tokens');
    if (savedRefreshPref !== null) {
        const checkbox = document.getElementById("enable-refresh");
        if (checkbox) checkbox.checked = (savedRefreshPref === 'true');
    }

    // trigger change to set initial description and hints ONLY if not redirecting
    if (!isRedirect && select.options.length > 0) {
        select.dispatchEvent(new Event("change"));
    }
}

function hideLoginHints() {
    document.querySelectorAll('[id^="login_hint_"]').forEach(el => {
        el.classList.add('hidden');
    });
}


// ==========================
// GLOBALS & HELPER FUNCTIONS
// ==========================

function withLoader(spinnerId, promise) {
    const spinner = document.getElementById(spinnerId);
    spinner.classList.remove("hidden");

    return promise.finally(() => {
        spinner.classList.add("hidden");
    });
}

function isNullOrEmpty(str) {
    // Check for null or undefined (using loose equality is a common idiom for this)
    if (str == null) {
        return true;
    }

    // Check for an empty string or a string with only whitespace after trimming
    return typeof str === 'string' && str.trim().length === 0;
}

function showAlert(message, type = "error") {
    const alertsDiv = document.getElementById("app-alerts");
    const alertsText = document.getElementById("app-alerts-text");
    if (!alertsDiv || !alertsText) return;

    alertsText.textContent = message;

    // Map types to exact Tailwind styling
    if (type === "warning") {
        alertsDiv.className = "mb-4 mt-4 p-4 border-2 rounded-xl bg-yellow-50 border-yellow-200 text-yellow-800";
    } else if (type === "info") {
        alertsDiv.className = "mb-4 mt-4 p-4 border-2 rounded-xl bg-blue-50 border-blue-200 text-blue-800";
    } else {
        alertsDiv.className = "mb-4 mt-4 p-4 border-2 rounded-xl bg-red-50 border-red-200 text-red-800";
    }

    alertsDiv.classList.remove("hidden");
}

function formatDateTime(dateInput) {
    try {
        // Basic check for null/undefined
        if (dateInput === null || dateInput === undefined) return "";

        const date = new Date(dateInput);

        // If the Date object is invalid, return the original input as a string
        if (isNaN(date.getTime())) {
            return String(dateInput);
        }

        // Format to dd/MM/yy HH:mm
        return new Intl.DateTimeFormat('en-GB', {
            day: '2-digit',
            month: 'short',
            year: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            hourCycle: 'h23' // Ensures 00-23 format
        }).format(date).replace(',', '');

    } catch (e) {
        // Final fallback for total failures
        return String(dateInput);
    }
}

// function showEhrError(msg) {
//     showAlert("EHR Launch Failed: " + msg, "error");
//     resetToLogin();
// }

// ===================================
// ENTRY POINT & APP LAUNCH HANDLER
// ===================================

FHIR.oauth2.ready()
    .then(async (client) => {
        // We set a flag so initApp knows if it needs to reset the expiry clock
        client._isRefreshOrNew = false;

        if (isRedirect) {
            // 1. THIS IS THE INITIAL LOGIN
            // Do NOT call refresh here; the token is brand new.
            debug("Freshly authorized!");
            client._isRefreshOrNew = true;
            initApp(client);
        } else {
            try {
                const expiresAt = localStorage.getItem('fhir_token_expires');

                // Fix: parseInt(expiresAt) correctly converts the timestamp string back to a comparable number
                if (expiresAt && Date.now() > parseInt(expiresAt)) {
                    // Force a refresh check before doing anything else
                    // This ensures the client object is active and valid
                    await client.refresh();
                    client._isRefreshOrNew = true;
                }

                // If we reach here, the token is valid or was successfully refreshed
                initApp(client);
            } catch (error) {
                console.warn("Token expired and refresh failed. Falling back to login...", error);
                resetToLogin("Token expired and refresh failed! Please sign in again.", "error");
            }
        }
    })
    .catch(error => {
        console.info("No active FHIR session found or OAuth Ready Error:", error);
        resetToLogin();
    });


async function handleAppLaunch() {

    debug("entering handleAppLaunch...");

    const urlParams = new URLSearchParams(window.location.search);
    const iss = urlParams.get("iss");
    const launch = urlParams.get("launch");

    // 1. EHR LAUNCH ROUTE 
    if (iss && launch) {

        debug("EHR Launch detected! \nISS: [" + iss + "]\nLaunch: [" + launch + "]");

        const config = await getConfig();
        let matchedEndpoint = null;
        let selectedKey = null;

        // Find which config endpoint matches the EHR's provided ISS URL
        for (const [key, endpoint] of Object.entries(config.fhir_endpoints)) {
            // Check both patient and provider URLs to smoothly catch Cerner sandbox splits
            const patientUrl = endpoint.patient_fhir_base_url || endpoint.fhir_base_url || "";
            const providerUrl = endpoint.provider_fhir_base_url || endpoint.fhir_base_url || "";

            if (iss.toLowerCase().startsWith(patientUrl.toLowerCase()) ||
                iss.toLowerCase().startsWith(providerUrl.toLowerCase())) {
                matchedEndpoint = endpoint;
                selectedKey = key;
                break;
            }
        }

        if (!matchedEndpoint) {
            console.error("EHR Launch failed: Unknown FHIR ISS URL provided:", iss);
            resetToLogin("Unknown FHIR ISS URL provided (" + iss + ").", "error");
            return;
        }

        if (!matchedEndpoint.provider_client_id) {
            console.error("EHR Launch failed: Provider Client ID is not configured for this endpoint.");
            resetToLogin("Provider Client ID is not configured for EHR Launch on " + matchedEndpoint.name + ".", "error");
            return;
        }

        // Save selected key to local storage so standard flow picks it up later
        localStorage.setItem('selected_fhir_endpoint', selectedKey);

        debug("Initiating EHR Launch Authorize...");
        isEhrRedirecting = true;

        // Immediately authorize the EHR context and redirect
        FHIR.oauth2.authorize({
            clientId: matchedEndpoint.provider_client_id,
            scope: matchedEndpoint.provider_scopes, // EHR Launch typically relies on provider_scopes
            redirectUri: config.redirect_uri,
            iss: iss
        });
    }
    // 2. OAUTH REDIRECT OR STANDALONE LOCAL ROUTE
    else {
        // If we get here, it's either an active Standalone Launch, OR we are returning 
        // from an OAuth redirect (code/state in URL). 
        // We let the existing FHIR.oauth2.ready() handle both gracefully!
        populateEndpoints();
    }

    debug("exiting handleAppLaunch!");
}

// Call it on script load
handleAppLaunch();

document.getElementById('fhir-endpoint').addEventListener('change', function () {
    hideLoginHints();
    if (this.value === 'epic') {
        document.getElementById('login_hint_epic').classList.remove('hidden');
    } else if (this.value === 'cerner') {
        document.getElementById('login_hint_cerner').classList.remove('hidden');
    }
});

document.getElementById("login-btn").addEventListener("click", async () => {

    debug("Entering login_click handler...");
    debug("window.location.href: [" + window.location.href + "]");

    const config = await getConfig();
    const selectedKey = document.getElementById("fhir-endpoint").value;
    const endpointConfig = config.fhir_endpoints[selectedKey];

    const enableRefresh = document.getElementById("enable-refresh")?.checked ?? true;

    // Save to local storage before redirecting!
    localStorage.setItem('selected_fhir_endpoint', selectedKey);
    localStorage.setItem('enable_refresh_tokens', enableRefresh ? 'true' : 'false');

    if (!endpointConfig) {
        alert("Please select a valid endpoint.");
        return;
    }

    let finalScopes = endpointConfig.patient_scopes;
    // Strip offline_access and online_access if checkbox is unchecked
    if (!enableRefresh) {
        finalScopes = finalScopes.replace(/\boffline_access\b/g, '')
            .replace(/\bonline_access\b/g, '')
            .replace(/\s+/g, ' ')
            .trim();
    }

    const baseIss = endpointConfig.patient_fhir_base_url || endpointConfig.fhir_base_url;

    debug("Redirect URI  : [" + config.redirect_uri + "]");
    debug("Client ID     : [" + endpointConfig.patient_client_id + "]");
    debug("Scope         : [" + finalScopes + "]");
    debug("Base URL      : [" + baseIss + "]");
    debug("enableRefresh : [" + enableRefresh + "]");

    if (!endpointConfig.patient_client_id) {
        alert("Patient Client ID is not configured for this endpoint!");
        return;
    }

    FHIR.oauth2.authorize({
        clientId: endpointConfig.patient_client_id,
        scope: finalScopes,
        redirectUri: config.redirect_uri,
        iss: baseIss
    });

    debug("Exiting login_click handler!");

    //document.getElementById("endpoint-selection").classList.add("hidden");

});

document.getElementById("logout-btn").addEventListener("click", () => {
    debug("logout clicked...");
    if (isEhrLaunch) {
        // Drop the tokens to prevent automatic background re-auth
        sessionStorage.clear();
        localStorage.removeItem('fhir_token_expires');

        // Attempt to close window (works perfectly in popups and some iframes)
        window.close();

        // Fallback for strict browsers or isolated iframes
        document.body.innerHTML = `
            <div class="flex items-center justify-center h-screen bg-gray-50">
                <div class="text-center p-8 bg-white border border-gray-200 shadow rounded-lg max-w-md">
                    <h2 class="text-2xl font-bold text-gray-800 mb-4">Signed Out</h2>
                    <p class="text-gray-600 mb-6">You have been securely signed out. You may now close this window or return to the EHR dashboard.</p>
                </div>
            </div>`;
    } else {
        resetToLogin("You have been signed out.", "info");
    }
});

// ==========================
// KEYBOARD SHORTCUTS
// ==========================
document.addEventListener('keydown', (e) => {
    // Alt + C to toggle observation codes
    if (e.altKey && e.key.toLowerCase() === 'c') {
        const codes = document.querySelectorAll('.obs-code');
        codes.forEach(c => c.classList.toggle('hidden'));
    }
});

const global_dict = {};
const global_dict_pii = {};

// ==========================
// AFTER AUTHENTICATION
// ==========================
async function initApp(client) {

    debug("entering initApp...");
    debug(client);

    client_session = client;

    const config = await getConfig();
    const savedEndpointKey = localStorage.getItem('selected_fhir_endpoint') || "";
    endpointConfig = config.fhir_endpoints[savedEndpointKey];
    endpointName = endpointConfig ? endpointConfig.name : savedEndpointKey;

    document.getElementById("curr_sandbox").classList.remove("hidden");
    document.getElementById("curr_sandbox").textContent = "Current Sandbox: [" + endpointName + "] [" + client.fhirBaseUrl + "]";

    // Hide login
    document.getElementById("logout-section").classList.remove("hidden");
    document.getElementById("login-section").classList.add("hidden");

    document.getElementById("recent-vitals").classList.add("hidden");
    hideLoginHints();

    // Attach Vitals Record Handler
    const globalRecordBtn = document.getElementById("global-record-btn");
    if (globalRecordBtn) {
        globalRecordBtn.addEventListener("click", handleGlobalRecordClick);
    }

    const patientId = client.patient.id;
    global_dict_pii.patientId = client.patient.id;
    global_dict_pii.encounterId = client.encounter?.id || null;

    if (global_dict_pii.encounterId) {
        debug("EHR Launch Encounter Context found! Encounter ID: [" + global_dict_pii.encounterId + "]");
        //global_dict.encounterId = global_dict_pii.encounterId;
    }

    // Bulletproof method: Check if this session was launched using the Provider Client ID
    if (endpointConfig && client.state.clientId === endpointConfig.provider_client_id) {
        isEhrLaunch = true;
        displayClinicianBanner(client, global_dict_pii.encounterId);
    } else {
        isEhrLaunch = false;
    }

    const tokenResponse = client.state.tokenResponse;
    let expiresAt = localStorage.getItem('fhir_token_expires');

    // Only recalculate the 10-minute expiry window if this is a brand new token 
    // (either fresh login OR just force-refreshed!)
    if (client._isRefreshOrNew || !expiresAt) {
        expiresAt = Date.now() + (tokenResponse.expires_in * 1000);
        localStorage.setItem('fhir_token_expires', expiresAt);
    } else {
        // We are simply reloading a page with a currently active, unexpired session!
        expiresAt = parseInt(expiresAt);
    }

    debug("Current Time: " + (new Date()).toLocaleString() + " | Token expiry time: " + (new Date(expiresAt)).toLocaleString());

    // Start background refresh or normal expiry timer
    if (tokenResponse.refresh_token) {
        debug("Refresh token present! Enabling background session refresh...");
        // If we reloaded the page, recalculate exactly how many seconds are left right now!
        const remainingSeconds = Math.max(1, Math.floor((expiresAt - Date.now()) / 1000));
        scheduleTokenRefresh(client, remainingSeconds);
    } else {
        debug("No refresh token present. Setting standard session timeout...");

        const warningText = "Refresh token not available. Session will expire at " + (new Date(expiresAt)).toLocaleTimeString() + ". Please sign in again when prompted.";

        // Show our global alert!
        showAlert(warningText, "warning");

        const msRemaining = Math.max(0, expiresAt - Date.now());

        session_timer_id = setTimeout(() => {
            debug('Current time: ' + (new Date()).toLocaleString() + ' | Token expired!');
            resetToLogin("Session expired! Please sign in again.", "warning");
        }, msRemaining);
    }

    document.getElementById("app-content").classList.remove("hidden");

    await Promise.all([
        loadPatient(client, global_dict_pii.patientId),
        //loadMedications(client, patientId),
        withLoader("medicationsSpinner", loadMedications(client, global_dict_pii.patientId)),
        withLoader("labRequestsSpinner", loadLabObservations(client, global_dict_pii.patientId)),
        withLoader("vitalsSpinner", loadVitals(client, global_dict_pii.patientId))
    ]);

    debug("All data loaded...");

    if (config.ai_integrations.enabled) {
        await getSmartMedicalInsights(global_dict);
    }

    debug("exiting initApp!");
}

function getPatientMRN(resPatient) {

    debug("Entering getPatientMRN...");
    const mrnIdentifier = resPatient.identifier?.find(id =>
        id.type?.coding?.some(coding => coding.code === 'MR')
    );

    const mrn = mrnIdentifier ? mrnIdentifier.value : "-";

    debug("Patient MRN: [" + mrn + "]");

    debug("Exiting getPatientMRN!");

    return mrn;

}

function getPatientIDs(resPatient) {

    debug("Entering getPatientIDs...");
    const otherIdentifiers = resPatient.identifier?.filter(id => {

        // 1. Check if the type code is NOT 'MR'
        const isNotMRNCode = !id.type?.coding?.some(c => c.code === 'MR');

        // 2. (Optional) Check if the system URI doesn't contain 'mrn' 
        // useful for systems that don't provide a 'type' object
        const isNotMRNSystem = !id.system?.toLowerCase().includes('mrn');

        return isNotMRNCode && isNotMRNSystem;
    }) || [];

    debug("Other IDs found:" + JSON.stringify(otherIdentifiers));

    debug("Exiting getPatientIDs!");

    return otherIdentifiers;
}

function getPatientIDsDisplay(resPatient) {

    debug("Entering getPatientIDsDisplay...");
    const otherIdentifiers = getPatientIDs(resPatient);

    if (!otherIdentifiers || otherIdentifiers.length === 0) {
        return "<div class='text-sm text-gray-500 italic p-4'>No other identifiers found.</div>";
    }

    let html = "<div class='grid grid-cols-4 gap-x-4 gap-y-2 bg-white p-4 rounded border border-gray-200'>";

    otherIdentifiers.forEach(id => {
        const typeDisplay = id.type?.coding?.[0]?.display || id.type?.text || id.system || "Other ID";
        html += `
            <div class="font-medium text-sm text-gray-600 flex items-center justify-end text-right">
                ${typeDisplay}:
            </div>
            <div class="text-sm text-gray-800 flex items-center break-all">
                ${id.value}
            </div>
        `;
    });

    html += "</div>";

    debug("Exiting getPatientIDsDisplay!");

    return html;
}

async function loadPatient(client, patientId) {

    debug("entering loadPatient...");
    await client.request(`Patient/${patientId}`)
        .then(patient => {

            debug("loadPatient started...");

            const name = patient.name?.[0];
            const fullName = `${name?.given?.join(" ")} ${name?.family}`;

            global_dict_pii.patientName = fullName;

            global_dict.gender = patient.gender;
            global_dict.birthDate = patient.birthDate;

            const html = `
        <div class="p-4 bg-gray-50 rounded">
            <table class="table-auto w-full bg-white border border-gray-300">
                <thead>
                    <tr class="bg-green-500">
                        <th>Name</th>
                        <th>Gender</th>
                        <th>DOB</th>
                        <th>MRN</th>
                    </tr>
                </thead>
                <tbody>
                    <tr class="border border-gray-300 px-4 py-2">
                        <td class="hover:bg-gray-100 text-center">${fullName}</td>
                        <td class="hover:bg-gray-100 text-center">${patient.gender}</td>
                        <td class="hover:bg-gray-100 text-center">${patient.birthDate}</td>
                        <td class="hover:bg-gray-100 text-center">${getPatientMRN(patient)}</td>
                    </tr>
                </tbody>
            </table>

            ${isEhrLaunch ? '' : `
            <details class="group mt-4">
                <summary class="ml-6 pl-4 font-normal cursor-pointer list-none flex items-center">
                    Other Identifiers <span class="ml-2 transition-transform group-open:rotate-180">▼</span>
                </summary>
                <div id="other-ids" class="mt-2 text-gray-800 px-6">
                    ${getPatientIDsDisplay(patient)}
                </div>
            </details>
            `}
        </div>
      `;

            document.getElementById("patient-info").innerHTML = html;

            debug("loadPatient finshed!");
        })
        .catch(error => {
            console.error("Error loading Patient:", error);
            document.getElementById("patient-info").innerHTML = `
                <div class="p-4 bg-red-50 border border-red-200 rounded text-red-600 text-sm font-semibold">
                    Failed to load patient information: ${error.message || "Unknown error occurred"}
                </div>`;
        });

    debug("exiting loadPatient!");
}

async function getPractitioner(client, practitionerId) {
    debug("entering getPractitioner [" + practitionerId + "]...");
    try {
        // You MUST return the result of the await
        const practitioner = await client.request(`Practitioner/${practitionerId}`);
        debug("Practitioner: ", JSON.stringify(practitioner));
        return practitioner;
    } catch (error) {
        debug("getPractitioner failed...");
        debug(error);
        return null;
    } finally {
        debug("exiting getPractitioner!");
    }
}

async function getEncounter(client, encounterId) {
    debug("entering getEncounter [" + encounterId + "]...");
    try {
        // You MUST return the result of the await
        const encounter = await client.request(`Encounter/${encounterId}`);
        debug("Encounter: ", JSON.stringify(encounter));
        return encounter;
    } catch (error) {
        debug("getEncounter failed...");
        debug(error);
        return null;
    } finally {
        debug("exiting getEncounter!");
    }
}

async function displayClinicianBanner(client, encounterId) {

    debug("entering displayClinicianBanner [" + encounterId + "]...");

    // Epic and Cerner hide the Practitioner ID in wildly different places depending on SMART v1 vs v2
    let practitionerId = null;
    let rawIdToken = client.state.idToken;

    // If fhirclient skipped parsing the id_token natively, manually decode it!
    if (!rawIdToken && client.state.tokenResponse?.id_token) {
        try {
            const base64Url = client.state.tokenResponse.id_token.split('.')[1];
            const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
            rawIdToken = JSON.parse(decodeURIComponent(atob(base64).split('').map(function (c) {
                return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2);
            }).join('')));
        } catch (e) {
            debug("Failed to manually decode id_token for practitioner extraction.");
        }
    }

    if (client.user && client.user.resourceType === "Practitioner" && client.user.id) {
        practitionerId = client.user.id;
    } else if (client.state.tokenResponse?.practitioner) {
        practitionerId = client.state.tokenResponse.practitioner;
    } else if (rawIdToken?.fhirUser) {
        const parts = rawIdToken.fhirUser.split("/");
        practitionerId = parts[parts.length - 1];
    } else if (rawIdToken?.sub) {
        // Fallback: Epic Sandbox subject claims sometimes contain the naked Provider ID
        practitionerId = rawIdToken.sub;
    }

    if (practitionerId) {
        // Strip any prefixes off the ID 
        practitionerId = practitionerId.replace("Practitioner/", "");

        let fullName = "--";

        // Get the Practitioner Role
        const practitioner = await getPractitioner(client, practitionerId);

        if (practitioner) {
            // Safely pluck the official name out of the JSON payload
            const name = practitioner.name && practitioner.name[0];
            if (name) {
                fullName = `${name.given?.join(" ")} ${name.family}`;
            }
        }

        const banner = document.getElementById("clinician-banner");
        if (banner) {
            // Ensure Encounter ID displays correctly
            const encounterIdStr = global_dict_pii.encounterId ? global_dict_pii.encounterId : "None Provided";

            banner.innerHTML = `
                <div class="flex justify-between items-start w-full">
                    <div class="flex flex-col">
                        <span class="text-[9px] uppercase tracking-widest text-blue-700 font-semibold mt-1">Clinician/Provider Name</span>
                        <span class="font-semibold text-blue-900 text-lg">${fullName}</span>
                        <span class="text-xs text-blue-700 font-mono mt-0.5">${rawIdToken?.fhirUser || practitionerId}</span>
                        <div id="encounter-participants" class="text-[10px] text-blue-600 mt-1.5 font-medium opacity-80 italic max-w-md truncate"></div>
                    </div>
                    <div class="flex flex-col text-right min-w-[140px]">
                        <div class="flex flex-col">
                            <span class="text-[9px] uppercase tracking-widest text-blue-700 font-semibold mt-1">Admitted Time</span>
                            <span id="encounter-time" class="font-bold text-blue-900 text-base leading-none">--:--</span>
                        </div>
                        <div id="encounter-status-container" class="mt-2 text-right">
                            <span id="encounter-status" class="inline-block px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-tighter bg-blue-50 text-blue-600 border border-blue-100">...</span>
                        </div>
                    </div>
                </div>
            `;
            banner.classList.remove("hidden");

            await displayEncounterDetails(client, global_dict_pii.encounterId);
        }
    }

    debug("exiting displayClinicianBanner!");
}

async function displayEncounterDetails(client, encounterId) {
    debug("entering displayEncounterDetails [" + encounterId + "]...");
    try {
        //const encounter = await client.request(`Encounter/${encounterId}`);
        const encounter = await getEncounter(client, encounterId);

        debug("Encounter Details fetched: ", JSON.stringify(encounter));

        // 1. Extract and format Admitted Time
        const admittedTime = encounter.period?.start;
        const formattedTime = admittedTime ? formatDateTime(admittedTime) : "N/A";

        // 2. Extract Status
        const status = encounter.status || "-";

        // 3. Extract Participants
        const participantMap = new Map();
        encounter.participant?.forEach(p => {
            const name = p.individual?.display || "Unknown";
            const role = p.type?.[0]?.text || "Participant";
            if (participantMap.has(name)) {
                participantMap.set(name, `${participantMap.get(name)}, ${role}`);
            } else {
                participantMap.set(name, role);
            }
        });
        const participantsList = Array.from(participantMap.entries())
            .map(([name, roles]) => `${name} (${roles})`)
            .join(" | ");

        // Update UI Elements
        const timeEl = document.getElementById("encounter-time");
        const statusEl = document.getElementById("encounter-status");
        const participantsEl = document.getElementById("encounter-participants");

        if (timeEl) timeEl.textContent = formattedTime;

        if (statusEl) {
            statusEl.textContent = status;
            if (status === "finished") {
                statusEl.className = "inline-block px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-tighter bg-green-50 text-green-700 border border-green-100";
            } else if (status === "in-progress" || status === "arrived") {
                statusEl.className = "inline-block px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-tighter bg-blue-50 text-blue-700 border border-blue-100 animate-pulse";
            } else {
                statusEl.className = "inline-block px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-tighter bg-gray-50 text-gray-500 border border-gray-100";
            }
        }

        if (participantsEl) {
            participantsEl.textContent = participantsList ? `Care Team: ${participantsList}` : "";
            participantsEl.title = participantsList;
        }

        return encounter;
    } catch (error) {
        debug("Failed to populate Encounter details:", error);
        return null;
    } finally {
        debug("exiting displayEncounterDetails!");
    }
}

function debugJWT(client) {

    debug("=== RAW TOKEN RESPONSE ===");
    console.dir(client.state.tokenResponse);
    // Some versions of fhirclient securely parse the idToken natively:
    if (client.state.idToken) {
        debug("=== DECODED ID TOKEN (FHIRCLIENT) ===");
        console.dir(client.state.idToken);
    }
    // Otherwise, we can manually slice open the JWT string ourselves!
    else if (client.state.tokenResponse?.id_token) {
        try {
            const base64Url = client.state.tokenResponse.id_token.split('.')[1];
            const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
            const jsonPayload = decodeURIComponent(atob(base64).split('').map(function (c) {
                return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2);
            }).join(''));
            debug("=== DECODED ID TOKEN (MANUAL) ===");
            console.dir(JSON.parse(jsonPayload));
        } catch (e) {
            console.error("Failed to manual decode id_token:", e);
        }
    }
}

function handleOutcomes(outcomeResource, targetArr) {
    debug("entering handleOutcomes...");

    const issues = outcomeResource.issue?.map(issue => {
        const severity = issue.severity;
        const text = issue.details?.text || "No details provided!"
        // Combines them into one string: "[Severity] Text"
        return `[${severity.toUpperCase()}] ${text}`;
    }) || [];

    if (issues.length > 0) {
        targetArr.push(...issues);
        debug(`current outcomes lenght [${targetArr.length}]`)
    }

    debug("exiting handleOutcomes!")
}

function displayOutcomes(parentSection, targetList, targetArr) {

    if (targetArr.length > 0) {

        document.getElementById(parentSection).classList.remove("hidden");

        targetArr.forEach(issText => {
            const issli = document.createElement("li");
            issli.textContent = issText;
            targetList.appendChild(issli);
        });
    }

}

async function extractObservationDetails(resource) {
    // 1. Get the Observation Name and Code
    const obsName = resource.code?.text
        || resource.code?.coding?.[0]?.display
        || "Unknown Observation";

    const obsCode = resource.code?.coding?.[0]?.code || "";

    // 2. Get the Date (Falling back to edge-case fields if effectiveDateTime is absent)
    const obsDate = resource.effectiveDateTime
        || resource.effectivePeriod?.start
        || resource.issued
        || new Date().toISOString();

    let value = "-";
    let uom = "";
    let entryType = "quantity"; // default
    let rawComponents = [];

    // 3. Try to extract a top-level value[x]
    if (resource.valueQuantity) {
        value = (resource.valueQuantity.value !== undefined) ? resource.valueQuantity.value : "-";
        uom = resource.valueQuantity.unit || resource.valueQuantity.code || "";
        entryType = "quantity";
    }
    else if (resource.valueCodeableConcept) {
        value = resource.valueCodeableConcept.text
            || resource.valueCodeableConcept.coding?.[0]?.display
            || "-";
        entryType = "codeableconcept";
    }
    else if (resource.valueString !== undefined) {
        value = resource.valueString;
        entryType = "string";
    }

    // 4. If no top-level value exists, look for components (like Blood Pressure)
    else if (resource.component && resource.component.length > 0) {
        entryType = "component";

        // Let's specifically handle Blood Pressure formatting (Sys / Dia)
        const isBP = obsName.toLowerCase().includes("blood pressure");

        if (isBP) {
            let sys = "-", sysUom = "";
            let dia = "-", diaUom = "";

            resource.component.forEach(comp => {
                const compName = comp.code?.text || comp.code?.coding?.[0]?.display || "";
                const val = comp.valueQuantity?.value ?? "-";
                const unit = comp.valueQuantity?.unit ?? "";

                if (compName.toLowerCase().includes("systolic")) {
                    sys = val;
                    sysUom = unit;
                    rawComponents.push({ name: "Systolic", code: comp.code?.coding?.[0]?.code || "8480-6", value: val, unit: unit });
                } else if (compName.toLowerCase().includes("diastolic")) {
                    dia = val;
                    diaUom = unit;
                    rawComponents.push({ name: "Diastolic", code: comp.code?.coding?.[0]?.code || "8462-4", value: val, unit: unit });
                }
            });

            value = `${sys} / ${dia}`;
            uom = sysUom || diaUom;
        }
        else {
            // Generic fallback for any other multi-component observations
            resource.component.forEach(comp => {
                const cName = comp.code?.text || comp.code?.coding?.[0]?.display || "Component";
                const cVal = comp.valueQuantity ? comp.valueQuantity.value : (comp.valueString || "-");
                const cUom = comp.valueQuantity ? (comp.valueQuantity.unit || "") : "";

                rawComponents.push({ name: cName, code: comp.code?.coding?.[0]?.code || "", value: cVal, unit: cUom });
            });

            value = rawComponents.map(p => p.value).join(" / ");
            uom = rawComponents[0]?.unit || "";
        }
    }

    const retValue = {
        name: obsName,
        code: obsCode,
        value: String(value).trim(),
        uom: uom,
        obsDate: obsDate,
        entryType: entryType,
        components: rawComponents
    };


    debug("current : " + JSON.stringify(retValue));

    debug("new : " + JSON.stringify(await extractObservationDetailsNew(resource)));

    return retValue;

}

async function extractObservationDetailsNew(resource) {

    const config = await getConfig();
    const HEADER_LOINCS = config.loinc_config.header_codes_to_ignore.map(c => c.code);

    // get the best possible LOINC codes 

    //const getLoinc = (coding) => coding?.find(c => c.system === "http://loinc.org")?.code || "";
    const getBestLoincNotWorking = (coding) => {
        const loincs = coding?.filter(c => c.system === "http://loinc.org").map(c => c.code) || [];
        const validCodes = loincs.filter(code => !HEADER_LOINCS.includes(code));    // Filter out the headers
        if (validCodes.includes("59408-5")) return "59408-5";   // Prioritize Pulse Ox specifically if multiple exist - SPECIAL CASE
        return validCodes[0] || loincs[0] || "";
    };

    const getBestLoinc = (coding) => {
        // 1. Get all LOINC codes from the resource
        const loincs = coding?.filter(c => c.system === "http://loinc.org").map(c => c.code) || [];
        if (loincs.length === 0) return "";

        // 2. Filter out the headers (8716-3, etc.)
        const validCodes = loincs.filter(code => !HEADER_LOINCS.includes(code));

        // 3. Logic Check:
        // If we found specific codes (like 8867-4), return the first one.
        if (validCodes.length > 0) {
            // Handle the SpO2 special case within the valid codes
            if (validCodes.includes("59408-5")) return "59408-5";
            return validCodes[0];
        }

        // 4. Fallback: If ONLY headers were present, return the first header
        return loincs[0];
    };

    // get the observation date
    const obsDate = resource.effectiveDateTime || resource.effectivePeriod?.start || resource.issued || null;

    // extract the top-level value[x] / dataType
    if (resource.valueQuantity) {
        entryType = "quantity";
    }
    else if (resource.valueCodeableConcept) {
        entryType = "codeableconcept";
    }
    else if (resource.valueString !== undefined) {
        // ??? let's default everything else to string for now!!!
        entryType = "string";
    } else if (resource.component && resource.component.length > 0) {
        entryType = "component";
    }

    // create the base result object 
    const result = {
        name: resource.code?.text || "Observation",
        loinc: getBestLoinc(resource.code?.coding),
        obsDate: obsDate,
        entryType: entryType,
        measurements: [],
        displayValue: "", // The "Friendly" string
        uom: "",          // Primary unit
        resource: resource,  // original resource received from FHIR server
        notes: []
    };

    // 1. Logic for Panels (Blood Pressure, etc.)
    if (resource.component && resource.component.length > 0) {
        resource.component.forEach(comp => {
            result.measurements.push({
                name: comp.code?.text || "Component",
                loinc: getBestLoinc(comp.code?.coding),
                value: comp.valueQuantity?.value ?? null,
                unit: comp.valueQuantity?.unit || ""
            });
        });

        const bpOrder = config.loinc_config.bp_display_order;   // special case for BP handling
        result.measurements.sort((a, b) => (bpOrder[a.loinc] || 99) - (bpOrder[b.loinc] || 99));

        // Create the "Display String" for panels (e.g., "120 / 80")
        result.displayValue = result.measurements.map(m => m.value ?? "-").join(" / ");
        result.uom = result.measurements[0]?.unit || "";
    }
    // 2. Logic for Single Vitals (Weight, SpO2)
    else {
        const val = resource.valueQuantity?.value ?? resource.valueString ?? "-";
        const unit = resource.valueQuantity?.unit || "";

        result.measurements.push({
            name: result.name,
            loinc: result.loinc,
            value: val,
            unit: unit
        });

        result.displayValue = String(val);
        result.uom = unit;
    }

    // 3. Extract Notes
    if (resource.note && resource.note.length > 0) {
        result.notes = resource.note.map(n => n.text);
    }

    return result;
}

function createObservationTable(dataArray) {
    // 1. Create the Table and apply Tailwind styles
    const table = document.createElement('table');
    table.className = "min-w-full divide-y divide-gray-200 shadow-sm rounded-lg overflow-hidden";

    // 2. Create Header
    const thead = document.createElement('thead');
    thead.className = "bg-gray-50 cursor-pointer";
    thead.innerHTML = `
        <tr>
            <th data-sort="date" class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider hover:bg-gray-200 select-none">Date ↕</th>
            <th data-sort="name" class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider hover:bg-gray-200 select-none">Name ↕</th>
            <th data-sort="value" class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider hover:bg-gray-200 select-none">Value ↕</th>
        </tr>
    `;
    table.appendChild(thead);

    // 3. Create Body
    const tbody = document.createElement('tbody');
    tbody.className = "bg-white divide-y divide-gray-200";
    table.appendChild(tbody);

    function renderBody(data) {
        tbody.innerHTML = '';
        data.forEach(item => {
            const tr = document.createElement('tr');
            tr.className = "hover:bg-gray-50 transition-colors";

            const obsDateRaw = item.obsDate;
            const formattedDate = obsDateRaw ? new Date(obsDateRaw).toLocaleString() : "Unknown";

            // const codeHtml = item.code ? `<div class="obs-code hidden text-xs text-blue-500 mt-1 font-mono tracking-wider">[${item.code}]</div>` : "";
            // ${codeHtml}
            tr.innerHTML = `
                <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-500">${formattedDate}</td>
                <td class="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">
                    ${item.name || "Unknown"}
                </td>
                <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-500">${item.value || ""} ${item.uom || ""}</td>
            `;
            tbody.appendChild(tr);
        });
    }

    renderBody(dataArray);

    let sortConfig = { key: null, direction: 'asc' };

    // 4. Sorting logic
    thead.addEventListener('click', (e) => {
        const th = e.target.closest('th');
        if (!th) return;

        const key = th.dataset.sort;
        if (!key) return;

        if (sortConfig.key === key) {
            sortConfig.direction = sortConfig.direction === 'asc' ? 'desc' : 'asc';
        } else {
            sortConfig.key = key;
            sortConfig.direction = 'asc';
        }

        const sortedData = [...dataArray].sort((a, b) => {
            let valA, valB;
            if (key === 'date') {
                valA = a.obsDate ? new Date(a.obsDate).getTime() : 0;
                valB = b.obsDate ? new Date(b.obsDate).getTime() : 0;
            } else if (key === 'name') {
                valA = (a.name || "").toLowerCase();
                valB = (b.name || "").toLowerCase();
            } else if (key === 'value') {
                const numA = parseFloat(a.value);
                const numB = parseFloat(b.value);
                if (!isNaN(numA) && !isNaN(numB)) {
                    valA = numA;
                    valB = numB;
                } else {
                    valA = (a.value + "").toLowerCase();
                    valB = (b.value + "").toLowerCase();
                }
            }

            if (valA < valB) return sortConfig.direction === 'asc' ? -1 : 1;
            if (valA > valB) return sortConfig.direction === 'asc' ? 1 : -1;
            return 0;
        });

        renderBody(sortedData);
    });

    return table;
}

function filterTopNObservations(dataArray, topN) {
    const sortedByDate = [...dataArray].sort((a, b) => {
        const dateA = a.obsDate ? new Date(a.obsDate).getTime() : 0;
        const dateB = b.obsDate ? new Date(b.obsDate).getTime() : 0;
        return dateB - dateA;
    });

    const counts = {};
    const result = [];

    for (const item of sortedByDate) {
        const name = item.name || "Unknown";
        counts[name] = counts[name] || 0;
        if (counts[name] < topN) {
            result.push(item);
            counts[name]++;
        }
    }

    return result.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
}

async function loadMedications(client, patientId) {

    debug("entering loadMedications...");
    await client.request(`MedicationRequest?patient=${patientId}`)
        .then(bundle => {

            debug("loadMedications started...");
            const list = document.getElementById("med-list");
            list.innerHTML = "";

            document.getElementById("medrequest-outcomes").classList.add("hidden");
            const issList = document.getElementById("med-issues-list");
            issList.innerHTML = "";

            const outcomes = [];
            const medications = [];

            bundle.entry?.forEach(entry => {

                const resource = entry.resource;
                const resType = resource.resourceType;

                if (resType === "MedicationRequest") {

                    debug("Processing MedicationRequest...");
                    let displayName = resource.medicationCodeableConcept?.text;
                    const medReference = resource.medicationReference?.reference || "";

                    const dosageInstructions = resource.dosageInstruction?.map(ins => ins.text) || [];

                    if (isNullOrEmpty(displayName)) {
                        displayName = resource.medicationReference?.display || "";

                        // If there is still no display name, check inline contained resources 
                        if (isNullOrEmpty(displayName) && !isNullOrEmpty(medReference)) {
                            // If it starts with '#', it's a "Contained Resource" within the SAME JSON payload.
                            // We shouldn't send a network request for it; we look it up!
                            if (medReference.startsWith("#")) {
                                const containedMed = resource.contained?.find(c => c.id === medReference.substring(1));
                                if (containedMed) {
                                    displayName = containedMed.code?.text || containedMed.code?.coding?.[0]?.display || "Contained Medication";
                                } else {
                                    displayName = "Unknown Medication Reference";
                                }
                            } else {
                                // For real network requests, updating local string variables in a background promise 
                                // won't update the UI since the DOM rendering happens synchronously right below.
                                // Better to just print the reference URL for now:
                                displayName = "Ref: " + medReference;
                            }
                        }
                    }

                    if (!isNullOrEmpty(displayName)) {
                        medications.push(displayName);
                    }

                    const li = document.createElement("li");
                    li.textContent = displayName;
                    list.appendChild(li);


                    if (dosageInstructions.length > 0) {
                        const dosageRoot = document.createElement('ul');
                        dosageInstructions.forEach(text => {
                            const dosageText = document.createElement('li');
                            dosageText.textContent = text;
                            dosageText.style.fontStyle = "italic";

                            dosageRoot.appendChild(dosageText);
                            li.appendChild(dosageRoot);
                        });
                    }

                }

                if (resType === "OperationOutcome") {
                    debug("Processing OperationOutcome...");
                    handleOutcomes(resource, outcomes);
                }

            });

            if (medications.length > 0) {
                global_dict.medications = medications;
            }

            if (bundle.entry?.length == 0) {
                const li = document.createElement("li");
                li.textContent = `No Medications found!`;
                list.appendChild(li);
                document.getElementById("medications-count").textContent = "";
            } else {
                document.getElementById("medications-count").textContent = `(${bundle.entry?.length} entries)`;
            }

            if (outcomes.length > 0) {
                displayOutcomes("medrequest-outcomes", issList, outcomes);
            }

            debug("loadMedications finshed!");
        })
        .catch(error => {
            console.error("Error loading Medications:", error);
            const list = document.getElementById("med-list");
            list.innerHTML = `<li class="text-red-500 font-semibold text-sm">Failed to load medications: ${error.message || "Unknown error"}</li>`;
            document.getElementById("medrequest-outcomes").classList.add("hidden");
        });

    debug("exiting loadMedications!");
}

async function loadLabObservations(client, patientId) {

    debug("entering loadLabObservations...");

    await client.request(`Observation?patient=${patientId}&category=laboratory`)
        .then(async (bundle) => {

            debug("loadLabObservations started...");

            const list = document.getElementById("lab-list");
            list.innerHTML = "";

            document.getElementById("labrequest-outcomes").classList.add("hidden");
            const issList = document.getElementById("lab-issues-list");
            issList.innerHTML = "";

            const obsArray = [];
            const outcomes = [];
            const labResults = [];

            const obsPromises = bundle.entry?.map(async entry => {

                const resource = entry.resource;
                const resType = resource.resourceType;

                if (resType === "Observation") {
                    obsArray.push(await extractObservationDetailsNew(resource));
                }

                if (resType === "OperationOutcome") {
                    debug("Processing OperationOutcome...");
                    handleOutcomes(resource, outcomes);
                }

            }) || [];

            await Promise.all(obsPromises);

            const topNLabArr = filterTopNObservations(obsArray, 5);

            let lastLab = "";
            topNLabArr.forEach(item => {
                if (isNullOrEmpty(lastLab) || lastLab.trim().toLowerCase() !== item.name.trim().toLowerCase()) {
                    const li = document.createElement("li");
                    li.textContent = `${item.name}: `;
                    const span = document.createElement('span');
                    span.className = 'font-bold';
                    span.textContent = `${item.displayValue} ${item.uom}`;
                    li.appendChild(span);
                    list.appendChild(li);

                    lastLab = item.name.trim().toLowerCase();
                    labResults.push({ name: item.name, value: item.displayValue });
                }
            });

            // Only show the details table if at least one lab has history (more than 1 entry total)
            const showDetails = topNLabArr.length > labResults.length;
            let recentLabsDetails = document.getElementById("recent-labs");

            if (showDetails) {
                let labsTblContainer = document.getElementById("labs-table");

                if (!recentLabsDetails) {
                    recentLabsDetails = document.createElement('details');
                    recentLabsDetails.id = "recent-labs";
                    recentLabsDetails.className = "group mt-4";

                    recentLabsDetails.innerHTML = `
                    <summary class="ml-6 pl-4 font-normal cursor-pointer list-none flex items-center">
                        Last 5 Reports for all Lab Results <span class="ml-2 transition-transform group-open:rotate-180">▼</span>
                    </summary>
                    <div id="labs-table" class="mt-2 text-gray-800"></div>
                `;
                    const outcomesDiv = document.getElementById("labrequest-outcomes");
                    outcomesDiv.parentNode.insertBefore(recentLabsDetails, outcomesDiv);
                    labsTblContainer = document.getElementById("labs-table");
                } else {
                    recentLabsDetails.classList.remove("hidden");
                    labsTblContainer.innerHTML = "";
                }

                labsTblContainer.appendChild(createObservationTable(topNLabArr));
            } else if (recentLabsDetails) {
                // Hide it if it was previously created but the current patient has no history
                recentLabsDetails.classList.add("hidden");
            }

            if (labResults.length > 0) {
                global_dict.labResults = labResults;
            }

            if (bundle.entry?.length == 0) {
                const li = document.createElement("li");
                li.textContent = `No Lab observations found!`;
                list.appendChild(li);
                document.getElementById("lab-count").textContent = "";
            } else {
                document.getElementById("lab-count").textContent = `(Showing recent ${global_dict.labResults?.length} of ${bundle.entry?.length} entries)`;
            }


            if (outcomes.length > 0) {
                displayOutcomes("labrequest-outcomes", issList, outcomes);
            }

            debug("loadLabObservations finshed!");
        })
        .catch(error => {
            console.error("Error loading Lab Observations:", error);
            const list = document.getElementById("lab-list");
            list.innerHTML = `<li class="text-red-500 font-semibold text-sm">Failed to load lab results: ${error.message || "Unknown error"}</li>`;
            document.getElementById("labrequest-outcomes").classList.add("hidden");
        });

    debug("exiting loadLabObservations!");
}

async function loadVitals(client, patientId) {

    debug("entering loadVitals...");

    if (isEhrLaunch) {
        document.getElementById("global-record-btn").classList.remove("hidden");
    }

    await client.request(`Observation?patient=${patientId}&category=vital-signs`)
        .then(async (bundle) => {

            debug("loadVitals started ...");

            const list = document.getElementById("vitals-list");
            list.innerHTML = "";

            const vitalsTbl = document.getElementById("vitals-table");
            vitalsTbl.innerHTML = "";

            document.getElementById("vitalsrequest-outcomes").classList.add("hidden");
            const issList = document.getElementById("vitals-issues-list");
            issList.innerHTML = "";

            const obsArray = []
            const outcomes = [];

            const vitals = [];

            const obsPromises = bundle.entry?.map(async entry => {

                const resource = entry.resource;
                const resType = resource.resourceType;

                if (resType === "Observation") {
                    obsArray.push(await extractObservationDetailsNew(resource));
                }

                if (resType === "OperationOutcome") {
                    debug("Processing OperationOutcome...");
                    handleOutcomes(resource, outcomes);
                }

            }) || [];

            await Promise.all(obsPromises);

            const topNVitalsArr = filterTopNObservations(obsArray, 5);

            // Populate global_dict with UNIQUE observation types discovered (for the Record dropdown)
            const uniqueVitals = [];
            const seenCodes = new Set();
            obsArray.forEach(item => {
                if (item.code && !seenCodes.has(item.code)) {
                    seenCodes.add(item.code);
                    uniqueVitals.push(item);
                }
            });
            //vitals = uniqueVitals;

            let lastVital = "";
            topNVitalsArr.forEach(item => {
                if (isNullOrEmpty(lastVital) || lastVital.trim().toLowerCase() !== item.name.trim().toLowerCase()) {

                    let panelSubCode = "";
                    if (item.measurements && item.measurements.length > 1) {
                        panelSubCode = " [" + item.measurements.map(m => m.loinc).join(", ") + "]";
                    }

                    //debug(`last vital : [${lastVital}] new [${item.name}]`);
                    const codeBadge = item.loinc ? `<span class="obs-code hidden inline text-[10px] text-blue-600 font-mono bg-blue-50 px-1.5 py-0.5 rounded border border-blue-200">[${item.loinc + panelSubCode}]</span> ` : "";

                    const li = document.createElement("li");
                    li.className = "flex flex-col p-3 mb-3 bg-white border border-gray-200 rounded-xl shadow-sm hover:shadow-md transition-shadow group";

                    li.innerHTML = `
                    <div class="vitals-card-content flex flex-col w-full">
                        <div class="flex justify-between items-start w-full">
                            <div class="flex flex-row items-center">
                                ${codeBadge}&nbsp;<span class="inline text-sm font-semibold text-gray-800">${item.name}</span>
                                <div class="ml-1 text-xs text-gray-400">
                                    ${formatDateTime(item.obsDate)}
                                </div>
                            </div>
                            <!-- hiding this fella temporarily -->
                            <button class="${isEhrLaunch ? "hidden" : "hidden"} record-new-btn opacity-0 group-hover:opacity-100 text-xs text-blue-600 hover:text-blue-800 font-medium px-2 py-1 rounded hover:bg-blue-50 transition-all">
                                Record New
                            </button>
                        </div>
                        <div class="vitals-display-area flex justify-between items-end mt-1 w-full relative">
                            <div class="text-xl font-bold text-blue-900">
                                ${item.displayValue} <span class="text-sm font-medium text-gray-500 ml-1">${item.uom}</span>
                            </div>
                        </div>
                        <div class="text-xs text-gray-600 mt-1 flex-left">
                            ${item.notes.length > 0 ? `<ul>${item.notes.map(note => `<li>${note}</li>`).join('')}</ul>` : ""}
                        </div>
                        <div class="vitals-edit-area hidden mt-2 pt-2 border-t border-gray-100">
                            <!-- Form will be injected here -->
                        </div>
                    </div>
                `;

                    li.querySelector(".record-new-btn").addEventListener("click", () => {
                        toggleVitalsEditMode(li, item);
                    });

                    list.appendChild(li);

                    lastVital = item.name.trim().toLowerCase();
                    vitals.push(item);
                }
            });

            if (topNVitalsArr.length > 0) {
                vitalsTbl.appendChild(createObservationTable(topNVitalsArr));
                document.getElementById("recent-vitals").classList.remove("hidden");
            }

            if (vitals.length > 0) {
                global_dict.vitals = vitals;
            }

            if (bundle.entry?.length == 0) {
                const li = document.createElement("li");
                li.textContent = `No Vitals found!`;
                list.appendChild(li);
                document.getElementById("vitals-count").textContent = "";
            } else {
                document.getElementById("vitals-count").textContent = `(Showing recent ${vitals?.length} of ${bundle.entry?.length} entries)`;
            }

            if (outcomes.length > 0) {
                displayOutcomes("vitalsrequest-outcomes", issList, outcomes);
            }


            debug("loadVitals finshed!");
        })
        .catch(error => {
            console.error("Error loading Vitals:", error);
            const list = document.getElementById("vitals-list");
            list.innerHTML = `<li class="text-red-500 font-semibold text-sm">Failed to load vitals: ${error.message || "Unknown error"}</li>`;
            document.getElementById("vitalsrequest-outcomes").classList.add("hidden");
            document.getElementById("recent-vitals").classList.add("hidden");
        });

    debug("exiting loadVitals!");
}

// ==========================
// VITALS ENTRY UI LOGIC
// ==========================

function toggleVitalsEditModeOld(cardLi, item, isGlobal = false) {
    const displayArea = cardLi.querySelector(".vitals-display-area");
    const editArea = cardLi.querySelector(".vitals-edit-area");
    const recordBtn = cardLi.querySelector(".record-new-btn");

    if (!editArea) return;

    // Toggle Visibility
    displayArea?.classList.add("hidden");
    recordBtn?.classList.add("hidden");
    editArea.classList.remove("hidden");

    // Clear and Render Form
    editArea.innerHTML = "";

    // Header for the form
    const header = document.createElement("div");
    header.className = "text-xs font-bold text-blue-600 uppercase tracking-wider mb-2";
    header.textContent = `Recording New Entry: ${item.name}`;
    editArea.appendChild(header);

    const form = document.createElement("div");
    form.className = "space-y-3";

    // 1. Inputs based on type
    if (item.entryType === "component" && item.measurements?.length > 0) {
        // Multi-field entry (e.g. Blood Pressure)
        const row = document.createElement("div");
        row.className = "flex items-center gap-2";

        item.measurements.forEach((comp, idx) => {
            const group = document.createElement("div");
            group.className = "flex-1";
            group.innerHTML = `
            <label class="block text-[10px] text-gray-500 mb-0.5">${comp.name}</label>
            <input type="number" class="w-full p-1.5 border border-gray-300 rounded text-sm focus:ring-1 focus:ring-blue-500 outline-none" placeholder="${comp.value}">
        `;
            row.appendChild(group);

            if (idx < item.measurements.length - 1) {
                const separator = document.createElement("span");
                separator.className = "text-gray-400 mt-4";
                separator.textContent = "/";
                row.appendChild(separator);
            }
        });

        // Shared UOM for components
        const uomGroup = document.createElement("div");
        uomGroup.className = "w-20";
        uomGroup.innerHTML = `
        <label class="block text-[10px] text-gray-500 mb-0.5">Unit</label>
        <input type="text" value="${item.uom}" class="w-full p-1.5 border border-gray-300 rounded text-sm bg-gray-50 italic outline-none">
    `;
        row.appendChild(uomGroup);
        form.appendChild(row);

    } else {
        // Single field entry
        const row = document.createElement("div");
        row.className = "flex items-center gap-2";

        const valGroup = document.createElement("div");
        valGroup.className = "flex-1";
        const placeholder = (item.entryType === "quantity") ? item.value : "Enter value...";
        const inputType = (item.entryType === "quantity") ? "number" : "text";

        valGroup.innerHTML = `
        <label class="block text-[10px] text-gray-500 mb-0.5">Value</label>
        <input type="${inputType}" class="w-full p-1.5 border border-gray-300 rounded text-sm focus:ring-1 focus:ring-blue-500 outline-none" placeholder="${placeholder}">
    `;
        row.appendChild(valGroup);

        const uomGroup = document.createElement("div");
        uomGroup.className = "w-24";
        uomGroup.innerHTML = `
        <label class="block text-[10px] text-gray-500 mb-0.5">Unit</label>
        <input type="text" value="${item.uom}" class="w-full p-1.5 border border-gray-300 rounded text-sm bg-gray-50 italic outline-none">
    `;
        row.appendChild(uomGroup);
        form.appendChild(row);
    }

    // 2. Action Buttons
    const footer = document.createElement("div");
    footer.className = "flex justify-end gap-2 mt-4 pt-2 border-t border-gray-50";
    footer.innerHTML = `
    <button class="cancel-entry-btn px-3 py-1 text-xs text-gray-500 hover:text-gray-700 font-medium">Cancel</button>
    <button class="save-entry-btn px-4 py-1 bg-blue-600 text-white text-xs font-semibold rounded hover:bg-blue-700 shadow-sm transition-colors">Save Observation</button>
    `;

    footer.querySelector(".cancel-entry-btn").addEventListener("click", () => {
        if (isGlobal) {
            cardLi.remove();
        } else {
            editArea.classList.add("hidden");
            displayArea?.classList.remove("hidden");
            recordBtn?.classList.remove("hidden");
        }
    });

    footer.querySelector(".save-entry-btn").addEventListener("click", () => {
        debug(`[STUB] Saving new ${item.name} observation for patient...`);
        alert("Stub: Saving observation data (to be implemented)");
        // Logic to revert or close will go here after actual POST
    });

    editArea.appendChild(form);
    editArea.appendChild(footer);
}

function toggleVitalsEditModeInline(cardLi, item, isGlobal = false) {
    const displayArea = cardLi.querySelector(".vitals-display-area");
    const editArea = cardLi.querySelector(".vitals-edit-area");
    const recordBtn = cardLi.querySelector(".record-new-btn");

    if (!editArea) return;

    // --- ADDED: Array to hold references to the input elements ---
    const inputRefs = [];

    // Toggle Visibility
    displayArea?.classList.add("hidden");
    recordBtn?.classList.add("hidden");
    editArea.classList.remove("hidden");

    // Clear and Render Form
    editArea.innerHTML = "";

    // Header for the form
    const header = document.createElement("div");
    header.className = "text-xs font-bold text-blue-600 uppercase tracking-wider mb-2";
    header.textContent = `Recording New Entry: ${item.name}`;
    editArea.appendChild(header);

    const form = document.createElement("div");
    form.className = "space-y-3";

    // 1. Inputs based on type
    if (item.entryType === "component" && item.measurements?.length > 0) {
        // Multi-field entry (e.g. Blood Pressure)
        const row = document.createElement("div");
        row.className = "flex items-center gap-2";

        item.measurements.forEach((comp, idx) => {
            const group = document.createElement("div");
            group.className = "flex-1";
            group.innerHTML = `
            <label class="block text-[10px] text-gray-500 mb-0.5">${comp.name}</label>
            <input type="number" class="w-full p-1.5 border border-gray-300 rounded text-sm focus:ring-1 focus:ring-blue-500 outline-none" placeholder="${comp.value}">
        `;

            // --- ADDED: Capture reference for multi-field component ---
            const inputEl = group.querySelector('input');
            inputRefs.push({ name: comp.name, el: inputEl, loinc: comp.loinc }); // Storing name and loinc for context

            row.appendChild(group);

            if (idx < item.measurements.length - 1) {
                const separator = document.createElement("span");
                separator.className = "text-gray-400 mt-4";
                separator.textContent = "/";
                row.appendChild(separator);
            }
        });

        // Shared UOM for components
        const uomGroup = document.createElement("div");
        uomGroup.className = "w-20";
        uomGroup.innerHTML = `
        <label class="block text-[10px] text-gray-500 mb-0.5">Unit</label>
        <input type="text" value="${item.uom}" class="w-full p-1.5 border border-gray-300 rounded text-sm bg-gray-50 italic outline-none">
    `;
        row.appendChild(uomGroup);
        form.appendChild(row);

    } else {
        // Single field entry
        const row = document.createElement("div");
        row.className = "flex items-center gap-2";

        const valGroup = document.createElement("div");
        valGroup.className = "flex-1";
        const placeholder = (item.entryType === "quantity") ? item.value : "Enter value...";
        const inputType = (item.entryType === "quantity") ? "number" : "text";

        valGroup.innerHTML = `
        <label class="block text-[10px] text-gray-500 mb-0.5">Value</label>
        <input type="${inputType}" class="w-full p-1.5 border border-gray-300 rounded text-sm focus:ring-1 focus:ring-blue-500 outline-none" placeholder="${placeholder}">
    `;

        // --- ADDED: Capture reference for single field ---
        const inputEl = valGroup.querySelector('input');
        inputRefs.push({ name: item.name, el: inputEl, loinc: item.loinc });

        row.appendChild(valGroup);

        const uomGroup = document.createElement("div");
        uomGroup.className = "w-24";
        uomGroup.innerHTML = `
        <label class="block text-[10px] text-gray-500 mb-0.5">Unit</label>
        <input type="text" value="${item.uom}" class="w-full p-1.5 border border-gray-300 rounded text-sm bg-gray-50 italic outline-none">
    `;
        row.appendChild(uomGroup);
        form.appendChild(row);
    }

    // 2. Action Buttons
    const footer = document.createElement("div");
    footer.className = "flex justify-end gap-2 mt-4 pt-2 border-t border-gray-50";
    footer.innerHTML = `
    <button class="cancel-entry-btn px-3 py-1 text-xs text-gray-500 hover:text-gray-700 font-medium">Cancel</button>
    <button class="save-entry-btn px-4 py-1 bg-blue-600 text-white text-xs font-semibold rounded hover:bg-blue-700 shadow-sm transition-colors">Save Observation</button>
`;

    footer.querySelector(".cancel-entry-btn").addEventListener("click", () => {
        if (isGlobal) {
            cardLi.remove();
        } else {
            editArea.classList.add("hidden");
            displayArea?.classList.remove("hidden");
            recordBtn?.classList.remove("hidden");
        }
    });

    footer.querySelector(".save-entry-btn").addEventListener("click", async () => {

        // VALIDATE - to ensure all fields are selected!
        const hasData = inputRefs.every(ref => ref.el.value.trim() !== "");

        if (!hasData) {
            //alert("Please enter a value before saving.");
            // Find the first ref where the element value is empty
            const firstEmpty = inputRefs.find(ref => ref.el.value.trim() === "");

            if (firstEmpty) {
                firstEmpty.el.focus();
                // Optional: add a temporary red border
                firstEmpty.el.style.borderColor = "red";
                setTimeout(() => firstEmpty.el.style.borderColor = "", 2000);
            }

            return; // Stop the save process
        }

        // --- ADDED: Logic to extract data from inputRefs ---
        const submissionData = {
            main_loinc: item.loinc,
            timestamp: new Date().toISOString(),
            values: inputRefs.map(ref => ({
                component: ref.name,
                loinc: ref.loinc,
                value: ref.el.value,
                item: item
            }))
        };

        console.log(`[SAVING] ${item.name}:`, submissionData);

        // Call createObservation
        await createObservation(submissionData);

        console.log(`Saved ${item.name} values: ` + submissionData.values.map(v => `${v.component}: ${v.value}, ${v.item.uom}, ${v.item.name}`).join(", "));

        // Example logic to revert UI after save
        if (!isGlobal) {
            editArea.classList.add("hidden");
            displayArea?.classList.remove("hidden");
            recordBtn?.classList.remove("hidden");
        }
    });

    editArea.appendChild(form);
    editArea.appendChild(footer);

    // wire-up validation for the form to enable/disable the Save button
    const saveBtn = footer.querySelector(".save-entry-btn");
    saveBtn.disabled = true; // Initially disabled
    saveBtn.classList.add("opacity-50", "cursor-not-allowed"); // Optional: styling

    const inputs = editArea.querySelectorAll("input");

    inputs.forEach(input => {
        input.addEventListener("input", () => {
            const hasData = inputRefs.every(ref => ref.el.value.trim() !== "");
            saveBtn.disabled = !hasData;
            if (hasData) {
                saveBtn.classList.remove("opacity-50", "cursor-not-allowed");
            } else {
                saveBtn.classList.add("opacity-50", "cursor-not-allowed");
            }
        });
    });

}

function globalAddVitals(cardLi, item, isGlobal = false) {
    const displayArea = cardLi.querySelector(".vitals-display-area");
    const editArea = cardLi.querySelector(".vitals-edit-area");
    const recordBtn = cardLi.querySelector(".record-new-btn");

    if (!editArea) return;

    // --- ADDED: Array to hold references to the input elements ---
    const inputRefs = [];

    // Toggle Visibility
    displayArea?.classList.add("hidden");
    recordBtn?.classList.add("hidden");
    editArea.classList.remove("hidden");

    // Clear and Render Form
    editArea.innerHTML = "";

    // Header for the form
    const header = document.createElement("div");
    header.className = "text-xs font-bold text-blue-600 uppercase tracking-wider mb-2";
    header.textContent = `Recording New Entry: ${item.vital_sign}`;
    editArea.appendChild(header);

    const form = document.createElement("div");
    form.className = "space-y-3";

    // 1. Inputs based on type
    if (item.entry_type === "codeableconcept") {
        // Multi-field entry (e.g. Blood Pressure)
        const row = document.createElement("div");
        row.className = "flex items-center gap-2";

        item.components.forEach((comp, idx) => {
            const group = document.createElement("div");
            group.className = "flex-1";
            group.innerHTML = `
            <label class="block text-[10px] text-gray-500 mb-0.5">${comp.vital_sign}</label>
            <input type="number" class="w-full p-1.5 border border-gray-300 rounded text-sm focus:ring-1 focus:ring-blue-500 outline-none" placeholder="Enter Value">
        `;

            // --- ADDED: Capture reference for multi-field component ---
            const inputEl = group.querySelector('input');
            inputRefs.push({ obs_name: comp.vital_sign, obs_input_element: inputEl, obs_loinc_code: comp.loinc_code, obs_uom: comp.uom[0] }); // Storing name and loinc for context panel_loinc: item.loinc_code, panel_name: item.vital_sign

            row.appendChild(group);

            if (idx < item.components.length - 1) {
                const separator = document.createElement("span");
                separator.className = "text-gray-400 mt-4";
                separator.textContent = "/";
                row.appendChild(separator);
            }
        });

        // Shared UOM for components
        const uomGroup = document.createElement("div");
        uomGroup.className = "w-20";
        uomGroup.innerHTML = `
        <label class="block text-[10px] text-gray-500 mb-0.5">Unit</label>
        <input type="text" value="${item.components[0].uom[0]}" class="w-full p-1.5 border border-gray-300 rounded text-sm bg-gray-50 italic outline-none">
    `;
        row.appendChild(uomGroup);
        form.appendChild(row);

    } else {
        // Single field entry // Simple Type
        const row = document.createElement("div");
        row.className = "flex items-center gap-2";

        const valGroup = document.createElement("div");
        valGroup.className = "flex-1";
        //const placeholder = (item.entry_type === "quantity") ? item.value : "Enter value...";
        const placeholder = "Enter value...";
        const inputType = (item.entry_type === "quantity") ? "number" : "text";

        valGroup.innerHTML = `
        <label class="block text-[10px] text-gray-500 mb-0.5">Value</label>
        <input type="${inputType}" class="w-full p-1.5 border border-gray-300 rounded text-sm focus:ring-1 focus:ring-blue-500 outline-none" placeholder="${placeholder}">
    `;

        // --- ADDED: Capture reference for single field ---
        const inputEl = valGroup.querySelector('input');
        inputRefs.push({ obs_name: item.vital_sign, obs_input_element: inputEl, obs_loinc_code: item.loinc_code, obs_uom: item.uom[0] });

        row.appendChild(valGroup);

        const uomGroup = document.createElement("div");
        uomGroup.className = "w-24";
        uomGroup.innerHTML = `
        <label class="block text-[10px] text-gray-500 mb-0.5">Unit</label>
        <input type="text" value="${item.uom[0]}" class="w-full p-1.5 border border-gray-300 rounded text-sm bg-gray-50 italic outline-none">
    `;
        row.appendChild(uomGroup);
        form.appendChild(row);
    }

    // 2. Action Buttons
    const footer = document.createElement("div");
    footer.className = "flex justify-end gap-2 mt-4 pt-2 border-t border-gray-50";
    footer.innerHTML = `
    <button class="cancel-entry-btn px-3 py-1 text-xs text-gray-500 hover:text-gray-700 font-medium">Cancel</button>
    <button class="save-entry-btn px-4 py-1 bg-blue-600 text-white text-xs font-semibold rounded hover:bg-blue-700 shadow-sm transition-colors">Save Observation</button>
`;

    footer.querySelector(".cancel-entry-btn").addEventListener("click", () => {
        if (isGlobal) {
            cardLi.remove();
        } else {
            editArea.classList.add("hidden");
            displayArea?.classList.remove("hidden");
            recordBtn?.classList.remove("hidden");
        }
    });

    footer.querySelector(".save-entry-btn").addEventListener("click", async () => {

        // VALIDATE - to ensure all fields are selected!
        const hasData = inputRefs.every(ref => ref.obs_input_element.value.trim() !== "");

        if (!hasData) {
            //alert("Please enter a value before saving.");
            // Find the first ref where the element value is empty
            const firstEmpty = inputRefs.find(ref => ref.obs_input_element.value.trim() === "");

            if (firstEmpty) {
                firstEmpty.obs_input_element.focus();
                // Optional: add a temporary red border
                firstEmpty.obs_input_element.style.borderColor = "red";
                setTimeout(() => firstEmpty.obs_input_element.style.borderColor = "", 2000);
            }

            return; // Stop the save process
        }

        // --- ADDED: Logic to extract data from inputRefs ---
        const submissionData = {
            main_loinc_code: item.loinc_code,
            obs_display_name: item.vital_sign,
            obs_timestamp: new Date().toISOString(),
            values: inputRefs.map(ref => ({
                vital_sign: ref.obs_name,
                loinc_code: ref.obs_loinc_code,
                value: ref.obs_input_element.value,
                uom: ref.obs_uom
            }))
        };

        console.log(`[SAVING] ${item.name}:`, submissionData);

        // Call createObservation
        await createObservation(submissionData);

        console.log(`Saved ${item.name} values: ` + submissionData.values.map(v => `${v.vital_sign}: ${v.value}, ${v.uom}, [${v.loinc_code}]`).join(", "));

        // Example logic to revert UI after save
        if (!isGlobal) {
            editArea.classList.add("hidden");
            displayArea?.classList.remove("hidden");
            recordBtn?.classList.remove("hidden");
        }
    });

    editArea.appendChild(form);
    editArea.appendChild(footer);

    // wire-up validation for the form to enable/disable the Save button
    const saveBtn = footer.querySelector(".save-entry-btn");
    saveBtn.disabled = true; // Initially disabled
    saveBtn.classList.add("opacity-50", "cursor-not-allowed"); // Optional: styling

    const inputs = editArea.querySelectorAll("input");

    inputs.forEach(input => {
        input.addEventListener("input", () => {
            const hasData = inputRefs.every(ref => ref.obs_input_element.value.trim() !== "");
            saveBtn.disabled = !hasData;
            if (hasData) {
                saveBtn.classList.remove("opacity-50", "cursor-not-allowed");
            } else {
                saveBtn.classList.add("opacity-50", "cursor-not-allowed");
            }
        });
    });

}

async function handleGlobalRecordClick() {
    debug("Global Record clicked...");
    const list = document.getElementById("vitals-list");
    if (!list) return;

    const config = await getConfig();

    // 1. Create a "Template Select" Card at the top
    const li = document.createElement("li");
    li.className = "flex flex-col p-4 mb-3 bg-blue-50 border-2 border-dashed border-blue-200 rounded-xl";

    // Simple placeholder for selecting a Type
    const selectHtml = `
    <div class="mb-4">
        <label class="block text-xs font-bold text-blue-700 uppercase mb-2">Select Vital Type</label>
        <select class="vitals-type-select w-full p-2 border border-blue-300 rounded-lg text-sm bg-white outline-none">
            <option value="">-- Choose Vitals to Record --</option>
            ${(endpointConfig.vitals_loinc_codes || []).map(v => `<option value="${v.loinc_code}">${v.vital_sign}</option>`).join('')}
        </select>
    </div>
    <div class="vitals-edit-area"></div>
    <div class="flex justify-end mt-2 card-cancel-area">
            <button class="global-cancel-btn text-xs text-gray-500 hover:text-gray-700">Cancel</button>
    </div>
`;

    li.innerHTML = selectHtml;
    list.prepend(li); // Put it at the top

    li.querySelector(".global-cancel-btn").addEventListener("click", () => li.remove());

    li.querySelector(".vitals-type-select").addEventListener("change", function () {
        if (!this.value) return;

        // Hide cancel area once form starts
        li.querySelector(".card-cancel-area").classList.add("hidden");

        //const selectedVital = config.vitals_loinc_codes.find(v => v.loinc_code === this.value);
        const selectedVital = endpointConfig.vitals_loinc_codes.find(v => v.loinc_code === this.value);
        if (selectedVital) {
            globalAddVitals(li, selectedVital, true);
        } else {
            // Placeholder for "New/Custom" selection
            alert("Custom vital entry stub - please choose an existing type for now.");
        }
    });
}

function buildObservationFromSubmission(submissionData) {

    const { main_loinc_code, obs_display_name, obs_timestamp, values } = submissionData;

    //const loincCode = selectedVital ? selectedVital.code : "44484-3"; // Default to "Other" if not found

    // Build the FHIR Observation Resource Base structure
    const observation_base = {
        "resourceType": "Observation",
        "status": "final",
        "category": [
            {
                "coding": [
                    {
                        "system": "http://terminology.hl7.org/CodeSystem/observation-category",
                        "code": "vital-signs",
                        "display": "Vital Signs"
                    }
                ],
                "text": "Vital Signs"
            }
        ],
        "code": {
            "coding": [
                {
                    "system": "http://loinc.org",
                    "code": main_loinc_code,
                }
            ],
            "text": obs_display_name
        },
        "subject": {
            "reference": `Patient/${global_dict_pii.patientId}`,
        },
        "effectiveDateTime": obs_timestamp,
        "issued": new Date().toISOString(),
        "note": [
            {
                "text": "captured via EHR Launch"
            }
        ]
    };

    let observation = observation_base;

    if (values.length == 1) {

        observation.valueQuantity = {
            "value": parseFloat(values[0].value),
            "unit": values[0].uom,
            "system": "http://unitsofmeasure.org",
            "code": values[0].uom
        }

    } else {

        let components = [];

        for (let i = 0; i < values.length; i++) {
            const value = values[i];
            components.push({
                code: {
                    coding: [
                        {
                            system: "http://loinc.org",
                            code: value.loinc_code,
                        }
                    ],
                    text: value.vital_sign
                },
                valueQuantity: {
                    value: parseFloat(value.value),
                    unit: value.uom,
                    system: "http://unitsofmeasure.org",
                    code: value.uom
                }
            });
        }

        observation.component = components;

    }

    return observation;
}

async function createObservation(submissionData) {
    try {
        debug("entering createObservation...");

        const observation = buildObservationFromSubmission(submissionData);

        await client_session.request({
            url: "Observation",
            method: "POST",
            body: JSON.stringify(observation),
            headers: {
                "Content-Type": "application/fhir+json"
            }
        })
            .then(response => {
                debug("Observation created successfully:", JSON.stringify(response));
                return response;
            })
            .catch(error => {
                debug("createObservation failed...");
                debug(error);
                return null;
            }).finally(() => {
                debug("exiting createObservation!");
            });
    } catch (error) {
        debug("createObservation failed...");
        debug(error);
        return null;
    } finally {
        debug("exiting createObservation!");
    }
}


async function summarizeOld(patientInfo) {
    if (typeof window.ai === 'undefined' || !window.ai.summarizer) {
        console.warn("AI Summarizer not supported or enabled in this browser.");
        divAISummary
        document.getElementById('divAISummary').classList.add("hidden");
        document.getElementById('summary-box').textContent = "AI Summary unavailable in this browser.";
        return;
    }

    try {
        const capabilities = await window.ai.summarizer.capabilities();
        if (capabilities.available === 'no') {
            console.error("Summarizer is not available on this device.");
            return;
        }

        document.getElementById('divAISummary').classList.remove("hidden");

        document.getElementById('summary-box').innerHTML = `
            <div class="flex items-center space-x-2 animate-pulse">
                <div class="h-2 w-2 bg-indigo-400 rounded-full"></div>
                <p class="text-indigo-400 italic font-medium">Analyzing your health snapshot...</p>
            </div>
        `;

        const formattedData = JSON.stringify(patientInfo, null, 2);
        const prompt = `Summarize these medical results for a patient in simple terms: ${formattedData}`;

        const summarizer = await window.ai.summarizer.create();
        const result = await summarizer.summarize(prompt);


        document.getElementById('summary-box').textContent = result;
    } catch (err) {
        console.error("Summarization failed:", err);
    }
}

async function getAISummary(patientInfo) {

    debug("entering getAISummary...");

    const summaryBox = document.getElementById('summary-box');
    const container = document.getElementById('divAISummary');

    if (
        typeof window === "undefined" ||
        typeof window.ai !== "object" ||
        !window.ai.summarizer ||
        typeof window.ai.summarizer.create !== "function"
    ) {
        console.warn("AI Summarizer not supported in this browser.");
        container?.classList.add("hidden");
        summaryBox.textContent = "AI Summary unavailable in this browser.";
        debug("exiting getAISummary (1)!");
        return;
    }

    try {
        const capabilities = await window.ai.summarizer.capabilities();

        if (!capabilities || capabilities.available === "no") {
            console.warn("Summarizer not available on this device.");
            container?.classList.add("hidden");
            summaryBox.textContent = "AI model not available on this device.";
            debug("exiting getAISummary (2)!");
            return;
        }

        container?.classList.remove("hidden");

        summaryBox.innerHTML = `
        <div class="flex items-center space-x-2 animate-pulse">
            <div class="h-2 w-2 bg-indigo-400 rounded-full"></div>
            <p class="text-indigo-400 italic font-medium">
                Analyzing your health snapshot...
            </p>
        </div>
    `;

        const formattedData = JSON.stringify(patientInfo, null, 2);
        const prompt = `Summarize these medical results for a patient in simple terms:\n${formattedData}`;

        const summarizer = await window.ai.summarizer.create({
            type: "tl;dr",
            format: "plain-text",
            length: "medium"
        });

        const result = await summarizer.summarize(prompt);

        summaryBox.textContent = result;

        debug("AI Summariztion finished!");

    } catch (err) {
        console.error("Summarization failed:", err);
        summaryBox.textContent = "AI summary failed. Please try again.";
    } finally {
        debug("exiting getAISummary (3)!");
    }

}

async function getSmartMedicalInsights(patientInfo) {

    console.log("entering getSmartMedicalInsights...");

    const config = await getConfig();

    //const inputText = document.getElementById("medicalText").value;
    const inputText = JSON.stringify(patientInfo);
    const summaryBox = document.getElementById("summary-box");
    const container = document.getElementById("divAISummary");

    // 1. Show container and set loading state
    container.classList.remove("hidden");
    summaryBox.innerHTML = `
    <div class="flex items-center space-x-2 animate-pulse">
        <div class="h-2 w-2 bg-indigo-400 rounded-full"></div>
        <p class="text-indigo-400 italic font-medium">Analyzing your latest lab results...</p>
    </div>`;

    const provider = config.ai_integrations.provider;

    var llm_config = null;

    if (provider === "huggingface" && config.ai_integrations.huggingface) {
        llm_config = config.ai_integrations?.huggingface || {};
    }

    try {

        if (llm_config) {
            const response = await fetch(llm_config.api_url, {
                method: "POST",
                headers: {
                    "Authorization": `Bearer ${llm_config.hf_token}`,
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    model: `${llm_config.model_name}`,
                    messages: [
                        {
                            role: "system",
                            //content: "You are a concise medical assistant. Summarize strictly in 3-4 bullet points using simple language. Highlight critical values like high blood pressure in bold."
                            content: "You are a medical analyst. The patient will be reading this and hence use direct advisory tone or neutral explanatory tone. Rule 1: ***IMPORTANT*** Do NOT repeat the numerical values (height, weight, etc) unless they are critical. Rule 2: Provide strictly 3-5 INSIGHTS as markdown bullets (e.g. 'Blood pressure is dangerously high!'). Rule 3: Use simple language."
                        },
                        {
                            role: "user",
                            content: inputText
                        }
                    ],
                    max_tokens: 250,
                    temperature: 0.1 // Keeps summary crisp and factual
                })
            });

            console.log("about to call llm...");
            const data = await response.json();

            if (response.ok) {
                console.log("response.ok from LLM");
                var markdownText = data.choices[0].message.content;
                console.log(data.choices[0].message.content);

                // add \n\n to ensure bullets are properly taken into account! 
                markdownText = markdownText.replace(/\n\*/g, "\n\n*");

                var htmlText = window.markdown.toHTML(markdownText);

                // add proper style markers for any UL/LI items 
                htmlText = htmlText.replace(/<ul>/g, '<ul class="list-disc pl-6 space-y-3 mb-4">');
                htmlText = htmlText.replace(/<li>/g, '<li class="text-indigo-900 font-medium">');

                // 2. Parse Markdown and inject into the styled box
                summaryBox.innerHTML = htmlText;

            } else {
                summaryBox.innerHTML = `<p class="text-red-500">Error: ${data.error?.message || "Failed to analyze."}</p>`;
            }
        } else {
            summaryBox.innerHTML = `<p class="text-red-500">AI Integration not configured properly!</p>`;
        }
    } catch (error) {
        console.error("error occured while calling llm");
        console.error(error);
        summaryBox.innerHTML = `<p class="text-red-500">Connection error. Please try again.</p>`;
    } finally {
        console.log("exiting getSmartMedicalInsights!")
    }
}
