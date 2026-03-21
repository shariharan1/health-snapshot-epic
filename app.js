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
// ==========================
// ENTRY POINT
// ==========================

// If we're returning from Epic with an auth code,
// this resolves the OAuth flow automatically.
// FHIR.oauth2.ready()
//     .then(initApp)
//     .catch(() => {
//         // Not logged in yet — show login button
//         document.getElementById("login-section").classList.remove("hidden");
//     });

const isRedirect = new URLSearchParams(window.location.search).has("code");

//const marked = window.markdownit();

let dbug = true;

function debug(str) {
    if (dbug) {
        console.log(str);
    }
}

function withLoader(spinnerId, promise) {
    const spinner = document.getElementById(spinnerId);
    spinner.classList.remove("hidden");

    return promise.finally(() => {
        spinner.classList.add("hidden");
    });
}

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
            resetToLogin();
        }
    }, timeoutMs);

    debug("Exiting scheduleTokenRefresh!");
}

function resetToLogin() {
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

    const currSandbox = document.getElementById("curr_sandbox");
    if (currSandbox) currSandbox.classList.add("hidden");

    const logoutSection = document.getElementById("logout-section");
    if (logoutSection) logoutSection.classList.add("hidden");

    const appContent = document.getElementById("app-content");
    if (appContent) appContent.classList.add("hidden");

    const loginSection = document.getElementById("login-section");
    if (loginSection) loginSection.classList.remove("hidden");

    const fhirEndpoint = document.getElementById("fhir-endpoint");
    if (fhirEndpoint) {
        const changeEvent = new Event('change', { bubbles: true });
        fhirEndpoint.dispatchEvent(changeEvent);
    }

    if (session_timer_id !== null) {
        clearTimeout(session_timer_id);
        session_timer_id = null;
    }
}

FHIR.oauth2.ready()
    .then(async (client) => {
        if (isRedirect) {
            // 1. THIS IS THE INITIAL LOGIN
            // Do NOT call refresh here; the token is brand new.
            debug("Freshly authorized!");
            initApp(client);
        } else {
            try {
                const expiresAt = localStorage.getItem('fhir_token_expires');

                // Fix: parseInt(expiresAt) correctly converts the timestamp string back to a comparable number
                if (expiresAt && Date.now() > parseInt(expiresAt)) {
                    // Force a refresh check before doing anything else
                    // This ensures the client object is active and valid
                    await client.refresh();
                }

                // If we reach here, the token is valid or was successfully refreshed
                initApp(client);
            } catch (error) {
                console.warn("Token expired and refresh failed. Falling back to login...", error);
                resetToLogin();
            }
        }
    })
    .catch(error => {
        console.info("No active FHIR session found or OAuth Ready Error:", error);
        resetToLogin();
    });


// ==========================
// LOGIN HANDLER
// ==========================
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

populateEndpoints();

function hideLoginHints() {
    document.querySelectorAll('[id^="login_hint_"]').forEach(el => {
        el.classList.add('hidden');
    });
}

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

    debug("Redirect URI  : [" + config.redirect_uri + "]");
    debug("Client ID     : [" + endpointConfig.client_id + "]");
    debug("Scope         : [" + finalScopes + "]");
    debug("Base URL      : [" + endpointConfig.fhir_base_url + "]");
    debug("enableRefresh : [" + enableRefresh + "]");

    FHIR.oauth2.authorize({
        clientId: endpointConfig.client_id,
        scope: finalScopes,
        redirectUri: config.redirect_uri,
        iss: endpointConfig.fhir_base_url
    });

    debug("Exiting login_click handler!");

    //document.getElementById("endpoint-selection").classList.add("hidden");

});

document.getElementById("logout-btn").addEventListener("click", () => {
    debug("logout clicked...");
    resetToLogin();
});

const global_dict = {};

// ==========================
// AFTER AUTHENTICATION
// ==========================
async function initApp(client) {

    debug("entering initApp...");
    debug(client);

    client_session = client;

    const config = await getConfig();
    const savedEndpointKey = localStorage.getItem('selected_fhir_endpoint') || "";
    const endpointConfig = config.fhir_endpoints[savedEndpointKey];
    const endpointName = endpointConfig ? endpointConfig.name : savedEndpointKey;

    document.getElementById("curr_sandbox").classList.remove("hidden");
    document.getElementById("curr_sandbox").textContent = "Current Sandbox: [" + endpointName + "] [" + client.fhirBaseUrl + "]";

    // Hide login
    // document.getElementById("endpoint-selection").classList.add("hidden");
    // document.getElementById("login-btn").classList.add("hidden");
    document.getElementById("logout-section").classList.remove("hidden");
    document.getElementById("login-section").classList.add("hidden");

    document.getElementById("recent-vitals").classList.add("hidden");
    hideLoginHints();

    const patientId = client.patient.id;

    const tokenResponse = client.state.tokenResponse;
    const expiresAt = Date.now() + (tokenResponse.expires_in * 1000);

    localStorage.setItem('fhir_token_expires', expiresAt);
    debug("Current Time: " + (new Date()).toLocaleString() + " | Token expiry time: " + (new Date(expiresAt)).toLocaleString() + " | Token expires in: " + tokenResponse.expires_in + " seconds");

    // Start background refresh or normal expiry timer
    if (tokenResponse.refresh_token) {
        debug("Refresh token present! Enabling background session refresh...");
        scheduleTokenRefresh(client, tokenResponse.expires_in);
    } else {
        debug("No refresh token present. Setting standard session timeout...");

        const warningText = "Refresh token not available. Your session will expire in " + tokenResponse.expires_in + " seconds at " + (new Date(expiresAt)).toLocaleString() + ". Please sign in again to continue when required!";
        document.getElementById("refresh-token-warning-text").textContent = warningText;
        document.getElementById("refresh-token-warning").classList.remove("hidden");

        session_timer_id = setTimeout(() => {
            debug('Current time: ' + (new Date()).toLocaleString() + ' | Token expired!');
            resetToLogin();
        }, tokenResponse.expires_in * 1000);
    }

    document.getElementById("app-content").classList.remove("hidden");

    await Promise.all([
        loadPatient(client, patientId),
        //loadMedications(client, patientId),
        withLoader("medicationsSpinner", loadMedications(client, patientId)),
        withLoader("labRequestsSpinner", loadLabObservations(client, patientId)),
        withLoader("vitalsSpinner", loadVitals(client, patientId))
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
            <details class="group mt-4">
                <summary class="ml-6 pl-4 font-normal cursor-pointer list-none flex items-center">
                    Other Identifiers <span class="ml-2 transition-transform group-open:rotate-180">▼</span>
                </summary>
                <div id="other-ids" class="mt-2 text-gray-800 px-6">
                    ${getPatientIDsDisplay(patient)}
                </div>
            </details>
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

function isNullOrEmpty(str) {
    // Check for null or undefined (using loose equality is a common idiom for this)
    if (str == null) {
        return true;
    }

    // Check for an empty string or a string with only whitespace after trimming
    return typeof str === 'string' && str.trim().length === 0;
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

function extractObservationDetails(resource) {
    // 1. Get the Observation Name
    const obsName = resource.code?.text
        || resource.code?.coding?.[0]?.display
        || "Unknown Observation";

    // 2. Get the Date (Falling back to edge-case fields if effectiveDateTime is absent)
    const obsDate = resource.effectiveDateTime
        || resource.effectivePeriod?.start
        || resource.issued
        || new Date().toISOString();

    let value = "-";
    let uom = "";

    // 3. Try to extract a top-level value[x]
    if (resource.valueQuantity) {
        value = resource.valueQuantity.value ?? "-";
        uom = resource.valueQuantity.unit || resource.valueQuantity.code || "";
    }
    else if (resource.valueCodeableConcept) {
        value = resource.valueCodeableConcept.text
            || resource.valueCodeableConcept.coding?.[0]?.display
            || "-";
    }
    else if (resource.valueString !== undefined) {
        value = resource.valueString;
    }

    // 4. If no top-level value exists, look for components (like Blood Pressure)
    else if (resource.component && resource.component.length > 0) {

        // Let's specifically handle Blood Pressure formatting (Sys / Dia)
        const isBP = obsName.toLowerCase().includes("blood pressure");

        if (isBP) {
            let sys = "-", sysUom = "";
            let dia = "-", diaUom = "";

            resource.component.forEach(comp => {
                const compName = comp.code?.text || comp.code?.coding?.[0]?.display || "";

                if (compName.toLowerCase().includes("systolic")) {
                    sys = comp.valueQuantity?.value ?? "-";
                    sysUom = comp.valueQuantity?.unit ?? "";
                } else if (compName.toLowerCase().includes("diastolic")) {
                    dia = comp.valueQuantity?.value ?? "-";
                    diaUom = comp.valueQuantity?.unit ?? "";
                }
            });

            value = `${sys} / ${dia}`;
            uom = sysUom || diaUom; // They usually share the same UoM (mm[Hg])
        }
        else {
            // Generic fallback for any other multi-component observations
            // Formats like: "Part A: 5 mg | Part B: 10 mg"
            const compStrings = resource.component.map(comp => {
                const cName = comp.code?.text || comp.code?.coding?.[0]?.display || "Component";
                let cVal = comp.valueQuantity?.value || comp.valueCodeableConcept?.text || comp.valueString || "-";
                let cUom = comp.valueQuantity?.unit || "";
                return `${cName}: ${cVal} ${cUom}`.trim();
            });
            value = compStrings.join(" | ");
        }
    }

    return {
        name: obsName,
        value: String(value).trim(),
        uom: uom,
        obsDate: obsDate
    };
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

            tr.innerHTML = `
                <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-500">${formattedDate}</td>
                <td class="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">${item.name || "Unknown"}</td>
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

                        if (!isNullOrEmpty(displayName)) {
                            medications.push(displayName);
                        }

                        // this is just for testing!
                        if (!isNullOrEmpty(medReference)) {
                            client.request(medReference)
                                .then(medication => {
                                    displayName += " [" + medication.code?.text + " ]";
                                });
                        }

                        if (isNullOrEmpty(displayName)) {
                            if (isNullOrEmpty(medReference)) {
                                displayName = "Unknown";
                            } else {
                                client.request(medReference)
                                    .then(medication => {
                                        displayName += " [" + medication.code?.text + " ]";
                                    });
                            }
                        }

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

            if (bundle.total == 0) {
                const li = document.createElement("li");
                li.textContent = `No Medications found!`;
                list.appendChild(li);
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
        .then(bundle => {

            debug("loadLabObservations started...");

            const list = document.getElementById("lab-list");
            list.innerHTML = "";

            document.getElementById("labrequest-outcomes").classList.add("hidden");
            const issList = document.getElementById("lab-issues-list");
            issList.innerHTML = "";

            const obsArray = [];
            const outcomes = [];
            const labResults = [];

            bundle.entry?.forEach(entry => {

                const resource = entry.resource;
                const resType = resource.resourceType;

                if (resType === "Observation") {
                    obsArray.push(extractObservationDetails(resource));
                }

                if (resType === "OperationOutcome") {
                    debug("Processing OperationOutcome...");
                    handleOutcomes(resource, outcomes);
                }

            });

            const topNLabArr = filterTopNObservations(obsArray, 5);

            let lastLab = "";
            topNLabArr.forEach(item => {
                if (isNullOrEmpty(lastLab) || lastLab.trim().toLowerCase() !== item.name.trim().toLowerCase()) {
                    const li = document.createElement("li");
                    li.textContent = `${item.name}: `;
                    const span = document.createElement('span');
                    span.className = 'font-bold';
                    span.textContent = `${item.value} ${item.uom}`;
                    li.appendChild(span);
                    list.appendChild(li);

                    lastLab = item.name.trim().toLowerCase();
                    labResults.push({ name: item.name, value: item.value });
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

            if (bundle.total == 0) {
                const li = document.createElement("li");
                li.textContent = `No Lab observations found!`;
                list.appendChild(li);
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

    await client.request(`Observation?patient=${patientId}&category=vital-signs`)
        .then(bundle => {

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

            bundle.entry?.forEach(entry => {

                const resource = entry.resource;
                const resType = resource.resourceType;

                if (resType === "Observation") {
                    obsArray.push(extractObservationDetails(resource));
                }

                if (resType === "OperationOutcome") {
                    debug("Processing OperationOutcome...");
                    handleOutcomes(resource, outcomes);
                }

            });

            const topNVitalsArr = filterTopNObservations(obsArray, 5);

            let lastVital = "";
            topNVitalsArr.forEach(item => {
                if (isNullOrEmpty(lastVital) || lastVital.trim().toLowerCase() !== item.name.trim().toLowerCase()) {

                    //debug(`last vital : [${lastVital}] new [${item.name}]`);

                    const li = document.createElement("li");
                    li.textContent = `${item.name}: `;

                    const span = document.createElement('span');
                    span.className = 'font-bold';
                    span.textContent = `${item.value} ${item.uom}`;
                    li.appendChild(span);
                    list.appendChild(li);

                    lastVital = item.name.trim().toLowerCase();
                    vitals.push(item);
                }
            });

            if (vitals.length > 0) {
                global_dict.vitals = vitals;
            }

            if (topNVitalsArr.length > 0) {
                vitalsTbl.appendChild(createObservationTable(topNVitalsArr));
                document.getElementById("recent-vitals").classList.remove("hidden");
            }

            if (bundle.total == 0) {
                const li = document.createElement("li");
                li.textContent = `No Vitals found!`;
                list.appendChild(li);
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
