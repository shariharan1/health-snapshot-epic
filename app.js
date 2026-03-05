// ==========================
// CONFIGURATION
// ==========================
const CLIENT_ID = "56feba67-549f-4364-93b2-1cd0ab387b5b";

// Epic Sandbox example base URL
const FHIR_BASE_URL = "https://fhir.epic.com/interconnect-fhir-oauth/api/FHIR/R4";

const REDIRECT_URI = "http://localhost:3010";
//const REDIRECT_URI = "https://localhost:3443";

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

                if (expiresAt && Date.now() > Date(expiresAt)) {
                    // Force a refresh check before doing anything else
                    // This ensures the client object is active and valid
                    await client.refresh();
                }

                // If we reach here, the token is valid or was successfully refreshed
                initApp(client);
            } catch (error) {
                console.warn("Refresh failed, session expired. Re-authorizing...", error);
                // Optional: Auto-trigger re-login or show login button
                document.getElementById("logout-btn").click();
            }
        }
    })
    .catch(error => {
        console.error("OAuth Ready Error:", error);
        //document.getElementById("login-section").classList.remove("hidden");
        document.getElementById("logout-btn").click();
    });


// ==========================
// LOGIN HANDLER
// ==========================
document.getElementById("login-btn").addEventListener("click", () => {

    debug("login clicked...");
    debug(window.location.href);

    FHIR.oauth2.authorize({
        clientId: CLIENT_ID,
        scope: "launch/patient openid profile patient/Patient.read patient/MedicationRequest.read patient/Observation.read",
        redirectUri: REDIRECT_URI,
        iss: FHIR_BASE_URL
    });

});

document.getElementById("logout-btn").addEventListener("click", () => {

    debug("logout clicked...");
    client_session = null;

    document.getElementById("logout-btn").classList.add("hidden");
    document.getElementById("app-content").classList.add("hidden");

    document.getElementById("login-btn").classList.remove("hidden");
    document.getElementById("login_hint").classList.remove("hidden");

    if (session_timer_id !== null) {
        clearTimeout(session_timer_id);
        session_timer_id = null;
    }

});

const global_dict = {};

// ==========================
// AFTER AUTHENTICATION
// ==========================
async function initApp(client) {

    debug("entering initApp...");
    debug(client);

    client_session = client;

    // Hide login
    document.getElementById("login-btn").classList.add("hidden");
    document.getElementById("logout-btn").classList.remove("hidden");

    document.getElementById("recent-vitals").classList.add("hidden");
    document.getElementById("login_hint").classList.add("hidden");

    const patientId = client.patient.id;

    const tokenResponse = client.state.tokenResponse;

    const expiresAt = Date.now() + (tokenResponse.expires_in * 1000);

    localStorage.setItem('fhir_token_expires', expiresAt);

    debug("About to print expiresAt");
    debug((new Date(expiresAt)).toLocaleString());

    debug("setting session timer...");
    session_timer_id = setTimeout(() => {
        debug('Token expired!');
        document.getElementById("logout-btn").click();
    }, tokenResponse.expires_in * 1000);

    document.getElementById("app-content").classList.remove("hidden");

    await Promise.all([
        loadPatient(client, patientId),
        //loadMedications(client, patientId),
        withLoader("medicationsSpinner", loadMedications(client, patientId)),
        withLoader("labRequestsSpinner", loadLabObservations(client, patientId)),
        withLoader("vitalsSpinner", loadVitals(client, patientId))
    ]);

    debug("All data loaded...");

    await getSmartMedicalInsights(global_dict);


    debug("exiting initApp!");
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
                        <th>ID</th>
                    </tr>
                </thead>
                <tbody>
                    <tr class="border border-gray-300 px-4 py-2">
                        <td class="hover:bg-gray-100 text-center">${fullName}</td>
                        <td class="hover:bg-gray-100 text-center">${patient.gender}</td>
                        <td class="hover:bg-gray-100 text-center">${patient.birthDate}</td>
                        <td class="hover:bg-gray-100 text-center">${patient.id}</td>
                    </tr>
                </tbody>
            </table>
        </div>
      `;

            document.getElementById("patient-info").innerHTML = html;

            debug("loadPatient finshed!");
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

function createVitalsTable(dataArray) {
    // 1. Create the Table and apply Tailwind styles
    const table = document.createElement('table');
    table.className = "min-w-full divide-y divide-gray-200 shadow-sm rounded-lg overflow-hidden";

    // 2. Create Header
    const thead = document.createElement('thead');
    thead.className = "bg-gray-50";
    thead.innerHTML = `
        <tr>
            <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Date</th>
            <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Name</th>
            <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Value</th>
        </tr>
    `;
    table.appendChild(thead);

    // 3. Create Body
    const tbody = document.createElement('tbody');
    tbody.className = "bg-white divide-y divide-gray-200";

    dataArray.forEach(item => {
        const tr = document.createElement('tr');
        tr.className = "hover:bg-gray-50 transition-colors"; // Tailwind hover effect

        // Use a helper or manual creation for cells
        tr.innerHTML = `
            <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-500">${new Date(item.obsDate).toLocaleString()}</td>
            <td class="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">${item.name}</td>
            <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-500">${item.value} ${item.uom}</td>
        `;
        tbody.appendChild(tr);
    });

    table.appendChild(tbody);
    return table;
}

function filterTopNVitals(dataArray, topN) {

    // 1. Sort by Date descending (newest first)
    // We do this first so the "top 5" are automatically the most recent
    const sortedByDate = [...dataArray].sort((a, b) =>
        new Date(b.obsDate) - new Date(a.obsDate)
    );

    const counts = {}; // To track how many we've added per name
    const result = [];

    // 2. Loop through and pick top 5 per name
    for (const item of sortedByDate) {
        const name = item.name;

        // Initialize count if not exists
        counts[name] = counts[name] || 0;

        // 3. Only add if we have fewer than 5 for this name
        if (counts[name] < topN) {
            result.push(item);
            counts[name]++;
        }
    }

    // 4. Final sort by Name (alphabetical) for the table view
    return result.sort((a, b) => a.name.localeCompare(b.name));

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

            const outcomes = [];
            const labResults = [];

            bundle.entry?.forEach(entry => {

                const resource = entry.resource;
                const resType = resource.resourceType;

                if (resType === "Observation") {
                    const obsName = resource.code?.text || "Unknown";

                    const value = resource.valueQuantity?.value || "-";

                    const li = document.createElement("li");
                    li.textContent = `${obsName}: `;

                    const span = document.createElement('span');
                    span.className = 'font-bold';
                    span.textContent = value;
                    li.appendChild(span);

                    list.appendChild(li);

                    labResults.push({ name: obsName, value: value });

                }

                if (resType === "OperationOutcome") {
                    debug("Processing OperationOutcome...");
                    handleOutcomes(resource, outcomes);
                }

            });

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

                    if (resource.valueQuantity) {
                        const obsItem = {
                            name: resource.code?.text || "Unknown",
                            value: resource.valueQuantity.value || "",
                            uom: resource.valueQuantity.unit || "",
                            obsDate: resource.effectiveDateTime
                        }

                        obsArray.push(obsItem);
                    } else {

                        // handle other types ... 
                        if (resource.component?.length > 0) {
                            // probably something found

                            const name = resource.code.text || "";
                            const obsDate = resource.effectiveDateTime;

                            let value = "", uom = "";

                            if (name.toLowerCase() === "blood pressure") {
                                let bp_sys = "";
                                let bp_sys_uom = "";
                                let bp_dia = "";
                                let bp_dia_uom = "";

                                resource.component.forEach(item => {
                                    if (item.code.text.toLowerCase().includes("systolic")) {
                                        bp_sys = item.valueQuantity.value;
                                        bp_sys_uom = item.valueQuantity.unit;
                                    }

                                    if (item.code.text.toLowerCase().includes("diastolic")) {
                                        bp_dia = item.valueQuantity.value;
                                        bp_dia_uom = item.valueQuantity.unit;
                                    }
                                });

                                value = `${bp_sys} / ${bp_dia}`;
                                uom = bp_sys_uom || bp_dia_uom;

                                const obsItem = {
                                    name: name,
                                    value: value,
                                    uom: uom,
                                    obsDate: obsDate
                                }
                                obsArray.push(obsItem);
                            }
                        }

                    }

                }

                if (resType === "OperationOutcome") {
                    debug("Processing OperationOutcome...");
                    handleOutcomes(resource, outcomes);
                }

            });

            const topNVitalsArr = filterTopNVitals(obsArray, 5);

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
                vitalsTbl.appendChild(createVitalsTable(topNVitalsArr));
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

    const API_URL = "https://router.huggingface.co/v1/chat/completions";
    const HF_TOKEN = "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"; // Replace with your actual token

    try {
        const response = await fetch(API_URL, {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${HF_TOKEN}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                model: "meta-llama/Llama-3.2-1B-Instruct",
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
    } catch (error) {
        console.error("error occured while calling llm");
        console.error(error);
        summaryBox.innerHTML = `<p class="text-red-500">Connection error. Please try again.</p>`;
    } finally {
        console.log("exiting getSmartMedicalInsights!")
    }
}
