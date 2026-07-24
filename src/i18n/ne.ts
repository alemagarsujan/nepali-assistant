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
    notifications: {
      title: "सूचना पढ्ने",
      description:
        "फोनमा आउने सूचना नेपालीमा ठूलो स्वरमा पढ्ने। अंग्रेजी सूचना पनि नेपालीमा अनुवाद गरी पढिनेछ। OTP/गोप्य कोड र बैंक/पैसा सम्बन्धी सूचना कहिल्यै पढिँदैन।",
      toggleOn: "सूचना पढ्ने सुरु गर्नुहोस्",
      toggleOff: "सूचना पढ्ने बन्द गर्नुहोस्",
      needsPermission: "अनुमति चाहिन्छ",
      permissionButton: "सूचना हेर्ने अनुमति दिनुहोस्",
      permissionHint: "खुल्ने सेटिङमा 'सहयोगी' खोजेर अनुमति दिनुहोस्, अनि फर्केर आउनुहोस्।",
      androidOnly: "यो सुविधा हाल एन्ड्रोइड फोनमा मात्र उपलब्ध छ।",
    },
  },
  errors: {
    noMicPermission: "माइक्रोफोन प्रयोग गर्न अनुमति चाहिन्छ।",
    noInternet: "इन्टरनेट जडान छैन। पछि फेरि प्रयास गर्नुहोस्।",
    genericRetry: "केही समस्या भयो। फेरि भन्नुहोस्।",
  },
};
