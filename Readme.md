* This is a Patient facing application connects to either EPIC or Cerner Sandbox to display thier particulars
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

  * implemented Refresh Tokens if and when user opts for it and if the sandbox supports it!
      * Refresh tokens works fine for Cerner but not for Epic!
      * need to look into securely storing refresh tokens for proper Refresh-Token usage in Epic!
  * utilizing experimental AI options on edge / chrome didn't work
  * tried over http as well as https
  * 
  * IMPORTANT TODO: Integrate with HF spaces to protect the HF Token
