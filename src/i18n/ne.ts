// All user-facing strings live here so a native Nepali speaker can review/fix
// wording in one place without touching component code.

export const strings = {
  home: {
    greeting: "नमस्ते! के सहयोग चाहियो?",
    listeningPrompt: "बोल्नुहोस्...",
    micButtonLabel: "बोल्न थिच्नुहोस्",
    processing: "सुन्दैछु...",
  },
  reminders: {
    title: "औषधिको समय",
    addNew: "नयाँ थप्नुहोस्",
    medicineName: "औषधिको नाम",
    time: "समय",
    confirmSpoken: (name: string, time: string) =>
      `${name} औषधि खाने समय ${time} बजे राखियो।`,
    alertSpoken: (name: string) => `${name} औषधि खाने समय भयो।`,
  },
  contacts: {
    title: "फोन गर्नुहोस्",
    confirmCall: (name: string) => `${name} लाई फोन गर्दैछु, पर्खनुहोस्।`,
    noMatch: "माफ गर्नुहोस्, त्यो नाम फेला परेन। फेरि भन्नुहोस्।",
  },
  settings: {
    title: "सेटिङ",
    voiceSpeed: "बोल्ने गति",
    pairCaregiver: "परिवारसँग जोड्नुहोस्",
    pairingCode: "यो कोड परिवारलाई दिनुहोस्:",
  },
  errors: {
    noMicPermission: "माइक्रोफोन प्रयोग गर्न अनुमति चाहिन्छ।",
    noInternet: "इन्टरनेट जडान छैन। पछि फेरि प्रयास गर्नुहोस्।",
    genericRetry: "केही समस्या भयो। फेरि भन्नुहोस्।",
  },
};
