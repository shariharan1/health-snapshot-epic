* This is a Patient facing application connects to EPIC Sandbox to display thier particulars
* Displays the following information:

  * Patient Info
  * Medication List (Medication Requests)
  * Laboratory Results (Observation?category=lab)
  * Vitals (Observation?category=vitals)

* On top of the above using the above, provides AI based Health Insights
* Technology

  * Simple HTML/Vanilla Javascript
  * tailwind for CSS
  * Connecting to Hugging Face for inferances purposes
  * using "meta-llama/Llama-3.2-1B-Instruct" model

* Other notes:

  * utilizing experimental AI options on edge / chrome didn't work
  * tried over http as well as https
  * IMPORTANT TODO: Integrate with HF spaces to protect the HF Token
