import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import nodemailer from "nodemailer";
import { Resend } from "resend";
import { GoogleGenAI } from "@google/genai";
import cors from "cors";
import dotenv from "dotenv";
import { initializeApp, getApps, applicationDefault } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { initializeApp as initializeClientApp } from 'firebase/app';
import { initializeFirestore, doc as clientDoc, setDoc as clientSetDoc, getDoc as clientGetDoc, collection as clientCollection, getDocs as clientGetDocs, deleteDoc as clientDeleteDoc } from 'firebase/firestore';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Use multiple strategies to find the config file
const getFirebaseConfig = () => {
    const paths = [
        path.join(process.cwd(), 'firebase-applet-config.json'),
        path.join(__dirname, '../firebase-applet-config.json'),
        path.join(__dirname, 'firebase-applet-config.json'),
        path.join(process.cwd(), 'api', 'firebase-applet-config.json')
    ];
    for (const p of paths) {
        if (fs.existsSync(p)) {
            console.log(`[Firebase] Config found at: ${p}`);
            return JSON.parse(fs.readFileSync(p, 'utf8'));
        }
    }
    // Final fallback: check root relative to this file
    try {
        const rootPath = path.resolve(__dirname, '..', 'firebase-applet-config.json');
        if (fs.existsSync(rootPath)) return JSON.parse(fs.readFileSync(rootPath, 'utf8'));
    } catch (e) {}

    throw new Error("firebase-applet-config.json not found. Please ensure the file is in the root directory.");
};

const firebaseConfig = getFirebaseConfig();

dotenv.config();

// Initialize Firebase Admin (Preferred for server-side)
if (getApps().length === 0) {
  try {
    if (process.env.VERCEL === "1") {
       initializeApp({ projectId: firebaseConfig.projectId });
    } else {
       initializeApp({
         credential: applicationDefault(),
         projectId: firebaseConfig.projectId || process.env.GOOGLE_CLOUD_PROJECT
       });
    }
  } catch (e: any) {
    try { initializeApp({ projectId: firebaseConfig.projectId }); } catch (inner) {}
  }
}

// Initialize Firebase Client SDK
const clientApp = initializeClientApp(firebaseConfig);
const clientDb = initializeFirestore(clientApp, {
  experimentalForceLongPolling: true
}, firebaseConfig.firestoreDatabaseId || "(default)");

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors());
app.set('trust proxy', true);

const INV_COL = "invitations";
const SETTINGS_COL = "settings";
const GLOBAL_SETTINGS_ID = "global";
const ARCHIVE_COL = "archives";

// Initialize Firestore Admin instance
let firestore: any;

// Memory Fallback for dev environments with storage issues
const memDb = {
  settings: new Map(),
  invitations: new Map(),
  archives: new Map()
};

async function autoInit() {
  try {
     const dbId = firebaseConfig.firestoreDatabaseId;
     console.log(`[Firestore Admin] Starting Auto-Init. Config DB: ${dbId || "(default)"}`);
     
     // 1. Try explicit databaseId if provided
     if (dbId && dbId !== "(default)") {
       try {
         const db = getFirestore(dbId);
         // Heartbeat
         await Promise.race([
           db.collection("settings").limit(1).get(),
           new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout")), 2500))
         ]);
         firestore = db;
         console.log(`[Firestore Admin] SUCCESS: Heartbeat passed for ${dbId}`);
         return;
       } catch (err: any) {
         console.warn(`[Firestore Admin] Heartbeat failed for ${dbId}: ${err.message}`);
         if (!String(err.message).includes("NOT_FOUND")) {
            firestore = getFirestore(dbId);
            return;
         }
       }
     }
     
     // 2. Try Default instance if no dbId or if named failed with NOT_FOUND
     try {
       const db = getFirestore();
       await Promise.race([
         db.collection("settings").limit(1).get(),
         new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout")), 2500))
       ]);
       firestore = db;
       console.log(`[Firestore Admin] SUCCESS: Connected to Default Database`);
       return;
     } catch (err: any) {
       console.warn(`[Firestore Admin] Default Database heartbeat failed: ${err.message}`);
     }

     // Final fallback: Use the configured one if it exists, else default
     firestore = dbId && dbId !== "(default)" ? getFirestore(dbId) : getFirestore();
  } catch (err: any) {
     console.error("CRITICAL: Firestore initialization error:", err.message);
     firestore = getFirestore();
  }
}

// Background init
autoInit().catch(e => console.error("[Background Init Error]", e));

// Helper to check if error is NOT_FOUND or PERMISSION_DENIED
const isStorageError = (e: any) => {
  if (!e) return false;
  const code = e.code;
  const msg = String(e.message || e).toUpperCase();
  return (
    code === 5 || 
    code === 7 || 
    msg.includes("NOT_FOUND") || 
    msg.includes("PERMISSION_DENIED") || 
    msg.includes("INSUFFICIENT PERMISSIONS")
  );
};

// Helper to get the correct base URL
const getBaseUrl = (req: express.Request, settings: any) => {
  if (settings.publicAppUrl && settings.publicAppUrl.trim() !== '') {
    return settings.publicAppUrl.trim().replace(/\/$/, '');
  }
  const host = req.get('x-forwarded-host') || req.get('host');
  const protocol = req.get('x-forwarded-proto') || req.protocol || 'https';
  if (host) return `${protocol}://${host}`;
  return process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'https://ais-dev-x27yhjnpefte6r5jvr2jwi-286785108129.europe-west2.run.app';
};

const getSettings = async () => {
    const getEnv = (key: string) => {
      const val = process.env[key] || process.env[`VITE_${key}`] || process.env[`NEXT_PUBLIC_${key}`] || "";
      return val.trim();
    };

    const envDefaults = {
      gmailUser: getEnv("GMAIL_USER") || getEnv("GMAIL_USERNAME"),
      gmailPass: getEnv("GMAIL_APP_PASSWORD") || getEnv("GMAIL_PASS") || getEnv("GMAIL_PASSWORD"),
      hubspotToken: getEnv("HUBSPOT_ACCESS_TOKEN") || getEnv("HUBSPOT_TOKEN") || getEnv("HUBSPOT_KEY"),
      publicAppUrl: getEnv("PUBLIC_APP_URL") || getEnv("APP_URL") || getEnv("VERCEL_URL"),
      geminiApiKey: getEnv("GEMINI_API_KEY") || getEnv("CUSTOM_GEMINI_API_KEY") || getEnv("VITE_GEMINI_API_KEY"),
      feedbackLink: getEnv("FEEDBACK_LINK") || "https://docs.google.com/forms/d/e/1FAIpQLSf5u5m2p1WvP..."
    };

    let firestoreData: any = null;

    if (firestore) {
      try {
        const settingsDoc = await firestore.collection(SETTINGS_COL).doc(GLOBAL_SETTINGS_ID).get();
        if (settingsDoc.exists) firestoreData = settingsDoc.data();
      } catch (e: any) {
        if (String(e.message).includes("PERMISSION_DENIED") || String(e.message).includes("7")) {
           firestore = null; 
        } else if (String(e.message).includes("NOT_FOUND")) {
           firestore = null; 
        }
      }
    }

    if (!firestoreData) {
      try {
        const snap = await clientGetDoc(clientDoc(clientDb, SETTINGS_COL, GLOBAL_SETTINGS_ID));
        if (snap.exists()) firestoreData = snap.data();
      } catch (e: any) {}
    }

    const result = { ...envDefaults };
    if (firestoreData) {
      Object.keys(firestoreData).forEach(key => {
        const val = firestoreData[key];
        if (val !== undefined && val !== null && String(val).trim() !== "") {
          result[key as keyof typeof result] = val;
        }
      });
    }
    return result;
};

const saveSettings = async (data: any) => {
    try {
      if (firestore) {
        try {
          await firestore.collection(SETTINGS_COL).doc(GLOBAL_SETTINGS_ID).set(data, { merge: true });
          return { type: 'admin', success: true };
        } catch (adminErr: any) {}
      }
      await clientSetDoc(clientDoc(clientDb, SETTINGS_COL, GLOBAL_SETTINGS_ID), data, { merge: true });
      return { type: 'client', success: true };
    } catch (e: any) {
      if (isStorageError(e)) {
        try {
          await clientSetDoc(clientDoc(clientDb, SETTINGS_COL, GLOBAL_SETTINGS_ID), data, { merge: true });
          return { type: 'client', success: true };
        } catch (inner) {
          memDb.settings.set(GLOBAL_SETTINGS_ID, data);
          return { type: 'memory', success: true };
        }
      }
      throw e;
    }
};

const getInvitation = async (id: string) => {
    try {
      if (firestore) {
        const invDoc = await firestore.collection(INV_COL).doc(id).get();
        if (invDoc.exists) return invDoc.data();
      }
      const snap = await clientGetDoc(clientDoc(clientDb, INV_COL, id));
      return snap.exists() ? snap.data() : memDb.invitations.get(id) || null;
    } catch (e: any) {
      return memDb.invitations.get(id) || null;
    }
};

const saveInvitation = async (id: string, data: any) => {
    try {
      if (firestore) {
        await firestore.collection(INV_COL).doc(id).set(data, { merge: true });
        return;
      }
      await clientSetDoc(clientDoc(clientDb, INV_COL, id), data, { merge: true });
    } catch (e: any) {
      try {
        await clientSetDoc(clientDoc(clientDb, INV_COL, id), data, { merge: true });
      } catch (inner) {
        memDb.invitations.set(id, { ...memDb.invitations.get(id), ...data });
      }
    }
};

const deleteInvitation = async (id: string) => {
    try {
      memDb.invitations.delete(id);
      if (firestore) {
        try { await firestore.collection(INV_COL).doc(id).delete(); return; } catch (e: any) {}
      }
      await clientDeleteDoc(clientDoc(clientDb, INV_COL, id));
    } catch (e: any) {}
};

const getAllInvitations = async () => {
    try {
      if (firestore) {
        try {
          const snapshot = await firestore.collection(INV_COL).get();
          return snapshot.docs.map((d: any) => ({ id: d.id, ...d.data() }));
        } catch (e) { if (!isStorageError(e)) throw e; }
      }
      const snap = await clientGetDocs(clientCollection(clientDb, INV_COL));
      return snap.docs.map(d => ({ id: d.id, ...d.data() }));
    } catch (e) {
      return Array.from(memDb.invitations.values());
    }
};

const getAllArchives = async () => {
    try {
      if (firestore) {
        try {
          const snapshot = await firestore.collection(ARCHIVE_COL).get();
          return snapshot.docs.map((d: any) => ({ id: d.id, ...d.data() }));
        } catch (e) { if (!isStorageError(e)) throw e; }
      }
      const snap = await clientGetDocs(clientCollection(clientDb, ARCHIVE_COL));
      return snap.docs.map(d => ({ id: d.id, ...d.data() }));
    } catch (e) {
      return Array.from(memDb.archives.values());
    }
};

const saveArchive = async (id: string, data: any) => {
    try {
      if (firestore) {
        try { await firestore.collection(ARCHIVE_COL).doc(id).set(data); return; } catch (e) {}
      }
      await clientSetDoc(clientDoc(clientDb, ARCHIVE_COL, id), data);
    } catch (e) { memDb.archives.set(id, data); }
};

const deleteArchive = async (id: string) => {
    try {
      memDb.archives.delete(id);
      if (firestore) {
        try { await firestore.collection(ARCHIVE_COL).doc(id).delete(); return; } catch (e) {}
      }
      await clientDeleteDoc(clientDoc(clientDb, ARCHIVE_COL, id));
    } catch (e) {}
};

const getAiInstance = (settings: any) => {
  const key = settings.geminiApiKey || process.env.CUSTOM_GEMINI_API_KEY || process.env.GEMINI_API_KEY;
  if (key && key.length > 5) return new GoogleGenAI({ apiKey: key });
  return null;
};

const getTransporter = async () => {
  const s = await getSettings();
  const user = s.gmailUser;
  const pass = s.gmailPass;
  if (!user || !pass) return null;
  return nodemailer.createTransport({
    service: 'gmail',
    auth: { user, pass },
  });
};

const getResend = () => {
  const resendKey = process.env.RESEND_API_KEY?.trim();
  if (resendKey && resendKey.startsWith('re_')) return new Resend(resendKey);
  return null;
};

// --- Routes ---

app.get("/api/debug", async (req, res) => {
  const s = await getSettings();
  const checkEnv = (key: string) => {
    const val = process.env[key] || process.env[`VITE_${key}`] || process.env[`NEXT_PUBLIC_${key}`] || "";
    if (!val) return "Missing";
    return `Present (Starts with: ${val.substring(0, 3)}...)`;
  };

  res.json({
    environment: process.env.NODE_ENV,
    isVercel: process.env.VERCEL === "1",
    firestore: firestore ? "Admin SDK Active" : "Client SDK Fallback",
    configSource: firebaseConfig.projectId,
    variables: {
      GMAIL_USER: checkEnv("GMAIL_USER"),
      GMAIL_PASS: checkEnv("GMAIL_APP_PASSWORD") || checkEnv("GMAIL_PASS"),
      HUBSPOT_TOKEN: checkEnv("HUBSPOT_ACCESS_TOKEN") || checkEnv("HUBSPOT_TOKEN"),
      GEMINI_API_KEY: checkEnv("GEMINI_API_KEY") || checkEnv("CUSTOM_GEMINI_API_KEY"),
      PUBLIC_APP_URL: checkEnv("PUBLIC_APP_URL"),
    }
  });
});

app.get("/api/rsvp", async (req, res) => {
  const { id, status } = req.query;
  if (!id) return res.status(400).send("Missing ID");
  try {
    const record = await getInvitation(id as string);
    if (!record) {
      await saveInvitation(id as string, { status, clickedAt: new Date().toISOString(), note: "Auto-created on RSVP" });
    } else {
      await saveInvitation(id as string, { status, clickedAt: new Date().toISOString() });
    }
    
    // Redirect logic simplified for this view
    res.send(`<div dir="rtl" style="font-family:sans-serif; text-align:center; padding:50px;"><h1>تم تسجيل ردك بنجاح!</h1><p>شكراً لك.</p></div>`);
  } catch (e: any) { res.status(500).send("Error"); }
});

app.get("/api/settings", async (req, res) => {
  const s = await getSettings();
  res.json(s);
});

app.post("/api/settings", async (req, res) => {
  const current = await getSettings();
  const updated = { ...current, ...req.body };
  const saveRes = await saveSettings(updated);
  res.json({ success: true, ...saveRes });
});

app.get("/api/invitations", async (req, res) => {
  const invs = await getAllInvitations();
  res.json(invs);
});

app.post("/api/invitations", async (req, res) => {
  const { id, ...data } = req.body;
  await saveInvitation(id, data);
  res.json({ success: true });
});

app.delete("/api/invitations/:id", async (req, res) => {
  await deleteInvitation(req.params.id);
  res.json({ success: true });
});

app.get("/api/archives", async (req, res) => {
  const archives = await getAllArchives();
  res.json(archives);
});

app.post("/api/archives", async (req, res) => {
  const { id, ...data } = req.body;
  await saveArchive(id, data);
  res.json({ success: true });
});

app.delete("/api/archives/:id", async (req, res) => {
  await deleteArchive(req.params.id);
  res.json({ success: true });
});

app.post("/api/mail/send-bulk", async (req, res) => {
    const { recipients, subject, bodyTemplate } = req.body;
    const settings = await getSettings();
    const transporter = await getTransporter();
    
    if (!transporter) return res.status(401).json({ error: "Email configuration missing" });

    const results = [];
    for (const person of recipients) {
      try {
        const personalizedBody = bodyTemplate.replace(/\{\{name\}\}/g, person.name);
        await transporter.sendMail({
          from: `"Doroob Community" <${settings.gmailUser}>`,
          to: person.email,
          subject: subject.replace(/\{\{name\}\}/g, person.name),
          html: personalizedBody
        });
        results.push({ email: person.email, success: true });
      } catch (e: any) {
        results.push({ email: person.email, success: false, error: e.message });
      }
    }
    res.json({ results });
});

// --- HubSpot API ---

const getHubSpotToken = async () => {
    const s = await getSettings();
    return s.hubspotToken;
};

app.post("/api/hubspot/search", async (req, res) => {
    const { topics } = req.body;
    const accessToken = await getHubSpotToken();
    if (!accessToken) return res.status(401).json({ error: "HubSpot configuration missing" });

    try {
        const keywords = Array.isArray(topics) ? topics : (topics || "").split(",").map((t: string) => t.trim()).filter(Boolean);
        if (keywords.length === 0) return res.json([]);

        // HubSpot search logic
        const candidates: any[] = [];
        const limitedSearchTerms = keywords.slice(0, 5);

        for (const keyword of limitedSearchTerms) {
            if (!keyword || keyword.length < 2) continue;
            
            try {
                const fetchSearch = async (body: any) => {
                    const hres = await fetch("https://api.hubapi.com/crm/v3/objects/contacts/search", {
                        method: "POST",
                        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${accessToken}` },
                        body: JSON.stringify(body)
                    });
                    if (hres.status === 429) {
                        await new Promise(resolve => setTimeout(resolve, 1000));
                        return fetchSearch(body); 
                    }
                    if (!hres.ok) return { results: [] };
                    return hres.json();
                };

                const res1 = await fetchSearch({
                    query: keyword,
                    properties: ["firstname", "lastname", "email", "jobtitle", "company", "phone", "role", "summary"],
                    limit: 100,
                });
                if (res1.results) candidates.push(...res1.results);
            } catch (e) {}
        }

        const uniqueContactsMap = new Map();
        candidates.forEach(c => {
            if (!uniqueContactsMap.has(c.id)) {
                let score = 0;
                const summary = (c.properties.summary || '').toLowerCase();
                const role = (c.properties.role || '').toLowerCase();
                keywords.forEach((k: string) => {
                    const kw = k.toLowerCase();
                    if (summary.includes(kw)) score += 20;
                    if (role.includes(kw)) score += 10;
                });
                uniqueContactsMap.set(c.id, { ...c, score });
            }
        });

        const sortedCandidates = Array.from(uniqueContactsMap.values()).sort((a, b) => b.score - a.score);
        res.json(sortedCandidates.slice(0, 100));
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

app.get("/api/hubspot/account", async (req, res) => {
    const accessToken = await getHubSpotToken();
    if (!accessToken) return res.status(401).json({ error: "Missing token" });
    try {
        const response = await fetch("https://api.hubapi.com/account-info/v3/details", {
            headers: { "Authorization": `Bearer ${accessToken}` }
        });
        const data = await response.json();
        res.json(data);
    } catch (error: any) { res.status(500).json({ error: error.message }); }
});

app.get("/api/hubspot/contacts", async (req, res) => {
    const accessToken = await getHubSpotToken();
    if (!accessToken) return res.status(401).json({ error: "Missing token" });
    try {
        const response = await fetch("https://api.hubapi.com/crm/v3/objects/contacts?limit=100&properties=firstname,lastname,email,jobtitle,company,phone,role,summary", {
            headers: { "Authorization": `Bearer ${accessToken}` }
        });
        const data = await response.json();
        res.json(data.results || []);
    } catch (error: any) { res.status(500).json({ error: error.message }); }
});

// --- Gemini AI ---
app.post("/api/gemini/generate", async (req, res) => {
    const { prompt } = req.body;
    const settings = await getSettings();
    const ai = getAiInstance(settings);
    if (!ai) return res.status(401).json({ error: "Gemini configuration missing" });
    try {
        const result = await ai.models.generateContent({
            model: "gemini-3-flash-preview",
            contents: [{ role: 'user', parts: [{ text: prompt }] }]
        });
        res.json({ text: result.text || "" });
    } catch (error: any) { res.status(500).json({ error: error.message }); }
});

// --- Invitations & Bulk Logic ---

app.post("/api/invitations/send", async (req, res) => {
    const { contacts, sessionDetails } = req.body;
    const settings = await getSettings();
    const results = [];
    
    const transporter = await getTransporter();
    const resend = getResend();

    for (const contact of contacts) {
      try {
        const inviteId = contact.id || `inv_${Date.now()}_${Math.random().toString(36).substring(7)}`;
        const baseUrl = getBaseUrl(req, settings);
        const rsvpYes = `${baseUrl}/api/rsvp?id=${inviteId}&status=yes`;
        const rsvpNo = `${baseUrl}/api/rsvp?id=${inviteId}&status=no`;

        const emailHtml = `
          <div dir="rtl" style="font-family: sans-serif; text-align: right; max-width: 600px; margin: 0 auto; border: 1px solid #eee; border-radius: 12px; overflow: hidden;">
            <div style="background: #ea580c; padding: 30px; text-align: center; color: white;">
              <h1 style="margin: 0;">دعوة خاصة</h1>
              <p style="opacity: 0.9;">نتشرف بدعوتك لحضور: ${sessionDetails?.title || "جلسة مجتمع دروب"}</p>
            </div>
            <div style="padding: 30px; color: #333; line-height: 1.6;">
              <p>أهلاً ${contact.properties.firstname || "صديقنا العزيز"}،</p>
              <p>يسرنا في مجتمع دروب دعوتك للانضمام إلينا في لقاء يجمعنا لنتشارك المعرفة والإلهام.</p>
              <div style="background: #fff7ed; padding: 20px; border-radius: 8px; margin: 20px 0; border-right: 4px solid #ea580c;">
                <strong>الموعد:</strong> ${sessionDetails?.date || "يحدد لاحقاً"}<br>
                <strong>المكان:</strong> ${sessionDetails?.location || "بالرياض - يرسل الموقع للمؤكدين"}
              </div>
              <p>لتأكيد حضورك أو الاعتذار، يرجى الضغط على أحد الخيارات التالية:</p>
              <div style="text-align: center; margin-top: 30px;">
                <a href="${rsvpYes}" style="background: #ea580c; color: white; padding: 12px 25px; text-decoration: none; border-radius: 6px; font-weight: bold; margin: 0 10px; display: inline-block;">سأحضر بالتأكيد ✅</a>
                <a href="${rsvpNo}" style="background: #f1f5f9; color: #475569; padding: 12px 25px; text-decoration: none; border-radius: 6px; font-weight: bold; margin: 0 10px; display: inline-block;">أعتذر عن الحضور ❌</a>
              </div>
            </div>
            <div style="background: #f8fafc; padding: 20px; text-align: center; font-size: 12px; color: #64748b; border-top: 1px solid #eee;">
              مجتمع دروب - حيث تبدأ رحلة التغيير
            </div>
          </div>
        `;

        let sentStatus = "sent";
        let messageId = "";
        let provider = "";

        // Try Resend first
        if (resend && contact.properties.email) {
          try {
            const data = await resend.emails.send({
              from: 'Doroob Community <onboarding@resend.dev>',
              to: [contact.properties.email],
              subject: `دعوة: ${sessionDetails?.title || "جلسة مجتمع دروب"}`,
              html: emailHtml,
            });
            messageId = data.data?.id || "";
            provider = "resend";
          } catch (resendErr: any) {
            console.error("Resend failed, falling back to Gmail:", resendErr.message);
          }
        }

        // Fallback to Gmail matching logic
        if (!messageId && transporter && contact.properties.email) {
          try {
            const gmailRes = await transporter.sendMail({
              from: `"Doroob Community" <${settings.gmailUser}>`,
              to: contact.properties.email,
              subject: `دعوة: ${sessionDetails?.title || "جلسة مجتمع دروب"}`,
              html: emailHtml
            });
            messageId = gmailRes.messageId;
            provider = "gmail";
          } catch (gmailError: any) {
            console.error("Gmail also failed for", contact.properties.email, gmailError.message);

            throw gmailError; // If both fail, throw to final catch
          }
        }

        // Store for tracking/reminders - MUST BE AWAITED
        try {
          const invTopic = sessionDetails?.title || "عام";
          await saveInvitation(inviteId, {
            email: contact.properties.email,
            name: contact.properties.firstname,
            sentAt: new Date().toISOString(),
            status: "pending",
            sessionDetails,
            mode: sentStatus,
            messageId,
            provider: provider,
            topic: invTopic // Use safe variable
          });
          console.log(`Successfully stored invitation document for ${contact.properties.email} (ID: ${inviteId})`);
          results.push({ email: contact.properties.email, status: sentStatus, provider: provider });
        } catch (saveErr: any) {
          console.error(`CRITICAL: Failed to save invitation to Firestore for ${contact.properties.email}:`, saveErr.message);
          results.push({ 
            email: contact.properties.email, 
            status: "sent_but_not_saved", 
            error: `فشل حفظ الدعوة في قاعدة البيانات: ${saveErr.message}` 
          });
        }
      } catch (err: any) {
        console.error("Final Email processing failure:", err);
        results.push({ 
          email: contact.properties.email, 
          status: "failed", 
          error: err.message,
          hint: "تأكد من إعدادات Gmail App Password بشكل صحيح."
        });
      }
    }

    res.json(results);
  });

  // Unified Event Check-in Page (HTML)
  app.get("/api/checkin/unified", async (req, res) => {
    res.send(`
      <!DOCTYPE html>
      <html lang="ar" dir="rtl">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>تحضير الحضور - مجتمع دروب</title>
        <link href="https://cdn.jsdelivr.net/npm/tailwindcss@2.2.19/dist/tailwind.min.css" rel="stylesheet">
        <link href="https://fonts.googleapis.com/css2?family=Tajawal:wght@400;700;900&display=swap" rel="stylesheet">
        <style>
          body { font-family: 'Tajawal', sans-serif; background-color: #FDFCFB; }
          .animate-fade-in { animation: fadeIn 0.6s ease-out; }
          @keyframes fadeIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
          .input-focus:focus { box-shadow: 0 0 0 4px rgba(234, 88, 12, 0.1); }
        </style>
      </head>
      <body class="flex items-center justify-center min-h-screen p-4">
        <div id="checkin-container" class="max-w-md w-full bg-white rounded-[40px] shadow-2xl p-10 text-center animate-fade-in border border-orange-50">
          <div class="w-20 h-20 bg-orange-600 rounded-3xl flex items-center justify-center mx-auto mb-8 shadow-lg rotate-3">
             <svg class="w-10 h-10 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"></path>
            </svg>
          </div>
          
          <h1 class="text-3xl font-black text-gray-900 mb-2 tracking-tight">أهلاً بك في دروب!</h1>
          <p class="text-gray-500 mb-8 font-medium">سجل حضورك الآن بلمسة واحدة</p>
          
          <form id="checkin-form" onsubmit="submitCheckin(event)" class="space-y-6 text-right">
            <div class="space-y-2">
              <label class="text-sm font-black text-gray-700 px-1">البريد الإلكتروني المسجل</label>
              <input 
                type="email" 
                id="email" 
                required 
                placeholder="example@gmail.com"
                class="w-full bg-gray-50 border border-slate-200 rounded-2xl py-4 px-6 text-lg focus:ring-2 focus:ring-orange-500 outline-none transition-all input-focus text-left"
              >
              <p class="text-[11px] text-gray-400 px-1">أدخل البريد الذي تلقيت عليه الدعوة، ثم اضغط الزر بالأسفل للتحضير.</p>
            </div>
            
            <div id="guest-fields" class="space-y-2 hidden animate-fade-in bg-orange-50 p-4 rounded-2xl border border-orange-100">
              <label class="text-sm font-black text-gray-700 px-1 text-orange-800">الاسم الثلاثي (للضيوف الجدد)</label>
              <input 
                type="text" 
                id="name" 
                placeholder="مثال: محمد أحمد صالح"
                class="w-full bg-white border border-orange-200 rounded-2xl py-4 px-6 text-lg focus:ring-2 focus:ring-orange-500 outline-none transition-all input-focus"
              >
            </div>

            <button 
              type="submit" 
              id="submit-btn"
              class="w-full bg-orange-600 text-white py-6 rounded-2xl font-black text-2xl hover:bg-orange-700 transition-all shadow-2xl shadow-orange-200 flex items-center justify-center active:scale-95 border-4 border-white/20"
            >
              تحضير
            </button>
          </form>

          <p id="status-msg" class="mt-6 text-sm font-bold text-orange-600 hidden"></p>
          
          <div class="mt-10 pt-8 border-t border-gray-50 opacity-50">
            <p class="text-[10px] font-black tracking-widest text-gray-400 uppercase">مجتمع دروب | Doroob Community</p>
          </div>
        </div>

        <script>
          let isGuestMode = false;

          async function submitCheckin(e) {
            e.preventDefault();
            const email = document.getElementById('email').value.toLowerCase().trim();
            const name = document.getElementById('name').value.trim();
            const btn = document.getElementById('submit-btn');
            const statusMsg = document.getElementById('status-msg');
            const guestFields = document.getElementById('guest-fields');

            btn.disabled = true;
            btn.innerHTML = 'جاري التحقق...';
            statusMsg.classList.add('hidden');

            try {
              const res = await fetch('/api/checkin/submit', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({ email, name, isGuest: isGuestMode })
              });

              const data = await res.json();

              if (res.status === 404 && !isGuestMode) {
                // Not found, prompt for name (Guest mode)
                isGuestMode = true;
                guestFields.classList.remove('hidden');
                btn.disabled = false;
                btn.innerHTML = 'تسجيل كضيف جديد';
                statusMsg.innerHTML = "أهلاً بك! إيميلك غير مسجل مسبقاً، يرجى كتابة اسمك لإضافتك كضيف.";
                statusMsg.classList.remove('hidden', 'text-green-600');
                statusMsg.classList.add('text-orange-600');
              } else if (res.ok) {
                showSuccess(data.name || 'صديق دروب');
              } else {
                throw new Error("حدث خطأ");
              }
            } catch (err) {
              btn.disabled = false;
              btn.innerHTML = 'اضغط هنا لتأكيد تحضيرك';
              statusMsg.innerText = "عذراً، حدث خطأ في الاتصال بالسيرفر.";
              statusMsg.classList.remove('hidden');
            }
          }

          function showSuccess(name) {
            const container = document.getElementById('checkin-container');
            container.innerHTML = \`
              <div class="w-24 h-24 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-8 shadow-inner">
                <svg class="w-12 h-12 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M5 13l4 4L19 7"></path>
                </svg>
              </div>
              <h1 class="text-3xl font-black text-gray-900 mb-4 tracking-tight">تم التحضير بنجاح!</h1>
              <p class="text-gray-600 text-lg mb-10 leading-relaxed font-medium">أهلاً بك \${name} في مجتمع دروب.<br>نسعد بتواجدك معنا اليوم.</p>
              <div class="p-6 bg-orange-50 text-orange-900 rounded-3xl text-sm font-black border border-orange-100">
                نتمنى لك جلسة مليئة بالإلهام والمعرفة.
              </div>
            \`;
          }
        </script>
      </body>
      </html>
    `);
  });

  // Automation: Check for reminders
  app.get("/api/automation/run", async (req, res) => {
    const invitations = await getAllInvitations();
    const now = new Date();
    const results = [];
    const transporter = await getTransporter();

    if (!transporter) return res.status(500).json({ error: "No email configuration found" });

    for (const record of invitations as any[]) {
      const sentTime = new Date(record.sentAt);
      const hoursDiff = (now.getTime() - sentTime.getTime()) / (1000 * 60 * 60);

      // 1. 3-hour reminder for non-responses
      if (record.status === "pending" && hoursDiff >= 3 && !record.reminded3h) {
        try {
          await transporter.sendMail({
            from: `"Doroob Community" <${record.gmailUser || process.env.GMAIL_USER}>`,
            to: record.email,
            subject: "تذكير: دعوة لجلسة غداً",
            html: `<div dir="rtl" style="text-align: right;">أهلاً ${record.name || 'صديق دروب'}، نذكرك بالدعوة المرسلة بخصوص جلسة ${record.sessionDetails?.title}. بانتظار ردك!</div>`
          });
          
          await saveInvitation(record.id, { reminded3h: true });
          results.push(`Sent 3h reminder to ${record.email}`);
        } catch (e) {
          console.error(e);
        }
      }
    }

    res.json({ processed: results });
  });

  // Attendance Tracking
  app.post("/api/invitations/attendance", async (req, res) => {
    const { id, attendance } = req.body;
    try {
      const record = await getInvitation(id);
      if (!record) {
        return res.status(404).json({ error: "Invitation not found" });
      }
      await saveInvitation(id, { attendance });
      res.json({ success: true, attendance });
    } catch (e) {
      res.status(500).json({ error: "Failed to update attendance" });
    }
  });

  // Handle Unified Check-in Submit
  app.post("/api/checkin/submit", async (req, res) => {
    const { email, name, isGuest } = req.body;
    try {
      const normalizedEmail = email?.toLowerCase().trim();
      
      // Look for existing invitation
      const invitations: any[] = await getAllInvitations();
      const existingEntry = invitations.find((v: any) => v.email?.toLowerCase().trim() === normalizedEmail);
      
      if (existingEntry) {
        const id = existingEntry.id;
        const updateData = {
          attendance: 'attended',
          checkedInAt: new Date().toISOString(),
          checkInMethod: 'unified-link',
          status: (existingEntry.status === 'pending' || existingEntry.status === 'sent') ? 'yes' : existingEntry.status
        };
        await saveInvitation(id, updateData);

        return res.json({ success: true, name: existingEntry.name });
      }

      if (!isGuest) {
        return res.status(404).json({ error: "Email not found" });
      }

      // Guest mode: create new record
      const guestId = 'guest_' + Math.random().toString(36).substring(7);
      const guestData = {
        email: normalizedEmail,
        name: name || 'ضيف خارجي',
        sentAt: new Date().toISOString(),
        status: 'yes',
        attendance: 'attended',
        checkedInAt: new Date().toISOString(),
        checkInMethod: 'unified-link-as-guest',
        mode: 'walk-in_guest',
        sessionDetails: { title: "جلسة مجتمع دروب (حضور مباشر)" }
      };
      await saveInvitation(guestId, guestData);

      res.json({ success: true, name: name });

    } catch (e) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Get all invitations with current statuses
  app.get("/api/invitations/all", async (req, res) => {
    try {
      const invitations = await getAllInvitations();
      res.json(invitations);
    } catch (e) {
      res.status(500).json({ error: "Failed to fetch invitations" });
    }
  });

  // Delete invitation
  app.delete("/api/invitations/:id", async (req, res) => {
    const { id } = req.params;
    try {
      await deleteInvitation(id);
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ error: "Failed to delete invitation" });
    }
  });

  // Archive current session
  app.post("/api/archives/create", async (req, res) => {
    const { notes } = req.body;
    try {
      const invitations: any[] = await getAllInvitations();
      if (invitations.length === 0) {
        return res.status(400).json({ error: "لا يوجد دعوات لأرشفتها" });
      }

      const firstGroup = invitations[0];
      const sessionTitle = firstGroup.sessionDetails?.title || "جلسة غير معنونة";
      const sessionDate = firstGroup.sessionDetails?.date || "";

      const stats = {
        totalInvited: invitations.length,
        confirmedAttending: invitations.filter(v => v.status === 'yes').length,
        attendedCount: invitations.filter(v => v.attendance === 'attended').length,
        confirmedButAbsent: invitations.filter(v => v.status === 'yes' && v.attendance !== 'attended').length,
        apologizedCount: invitations.filter(v => v.status === 'no').length,
        noResponseCount: invitations.filter(v => v.status === 'pending' || v.status === 'sent' || v.status === 'clicked').length,
      };

      const archiveId = `arch_${Date.now()}`;
      const archiveData = {
        title: sessionTitle,
        sessionDate: sessionDate,
        archivedAt: new Date().toISOString(),
        ...stats,
        notes: notes || "",
        // Store full attendee info (name/email) for the "Thanks" feature
        attendees: invitations
          .filter(v => v.attendance === 'attended')
          .map(v => ({ name: v.name, email: v.email })),
        // Include non-responders for record keeping
        nonResponders: invitations
          .filter(v => v.status === 'pending' || v.status === 'sent' || v.status === 'clicked')
          .map(v => ({ name: v.name, email: v.email })),
        // Include apologized guests
        apologized: invitations
          .filter(v => v.status === 'no')
          .map(v => ({ name: v.name, email: v.email })),
        // Include new guests who were added for this session
        newGuests: invitations
          .filter(v => v.isNew === true)
          .map(v => ({ name: v.name, email: v.email, phone: v.phone })),
        invitationIds: invitations.map(v => v.id)
      };

      await saveArchive(archiveId, archiveData);

      // After archiving, clear the current invitations board as requested
      for (const inv of invitations) {
        await deleteInvitation(inv.id);
      }

      res.json({ success: true, archiveId });
    } catch (e) {
      res.status(500).json({ error: "فشل أرشفة الجلسة" });
    }
  });

  // Get all archives
  app.get("/api/archives", async (req, res) => {
    try {
      const archives = await getAllArchives();
      res.json(archives);
    } catch (e) {
      res.status(500).json({ error: "Failed to fetch archives" });
    }
  });

  // --- HubSpot API ---
  // (HubSpot contact creation endpoint for manual applications removed)

  // Delete archive
  app.delete("/api/archives/:id", async (req, res) => {
    const { id } = req.params;
    try {
      await firestore.collection(ARCHIVE_COL).doc(id).delete();
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ error: "Failed to delete archive" });
    }
  });

  // Send Thanks & Survey Message
  app.post("/api/archives/:id/send-thanks", async (req, res) => {
    const { id } = req.params;
    try {
      const archives: any[] = await getAllArchives();
      const archive = archives.find(a => a.id === id);
      if (!archive) return res.status(404).json({ error: "الأرشيف غير موجود" });
      if (!archive.attendees || archive.attendees.length === 0) {
        return res.status(400).json({ error: "لا يوجد حضور مسجل لهذه الجلسة لإرسال الشكر لهم" });
      }

      const settings = await getSettings();
      const ai = getAiInstance(settings);
      
      const results = [];
      const transporter = await getTransporter();

      for (const attendee of archive.attendees) {
        try {
          // Generate customized thank you message using Gemini
          const prompt = `اكتب رسالة شكر ختامية قصيرة ومميزة باللغة العربية لشخص حضر جلسة بعنوان "${archive.title}". 
            اسم الشخص: ${attendee.name}. 
            المود: ملهم، ممتن، مهني. 
            يجب أن تتضمن الرسالة امتناناً لحضوره ومشاركته. 
            لا تزد عن 3-4 جمل قصيرة.`;
          
          let generatedBody = `شكراً جزيلاً لثقتك وحضورك معنا في هذه الجلسة. كانت مشاركتك إضافة قيمة أثرت الحوار وأسهمت في نجاح اللقاء. نحن في مجتمع دروب نكبر بوجودكم ونسعى دائماً لتقديم الأفضل.`;
          if (ai) {
            try {
              const aiResult = await ai.models.generateContent({
                model: "gemini-3-flash-preview",
                contents: [{ role: 'user', parts: [{ text: prompt }] }]
              });
              generatedBody = aiResult.text || generatedBody;
            } catch (aiErr: any) {
              console.error("Gemini AI failed in thanks message, using fallback:", aiErr.message);
            }
          }

          // Small delay to avoid rate limiting and 503s
          await new Promise(r => setTimeout(r, 800));

          const surveyLink = settings.feedbackLink || "#";
          
          const emailHtml = `
            <div dir="rtl" style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; text-align: right; color: #1e293b; line-height: 1.8; max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 24px; overflow: hidden; border: 1px solid #f1f5f9; box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.1);">
              <div style="background-color: #ea580c; padding: 50px 20px; text-align: center;">
                <div style="margin-bottom: 20px;">
                   <span style="background: rgba(255,255,255,0.2); padding: 8px 16px; border-radius: 12px; color: #ffffff; font-size: 12px; font-weight: bold; letter-spacing: 1px; text-transform: uppercase;">Doroob Community | مجتمع دروب</span>
                </div>
                <h1 style="color: #ffffff; margin: 0; font-size: 28px; font-weight: 900; letter-spacing: -0.5px;">مرحباً ${attendee.name} 👋</h1>
                <p style="color: #ffedd5; font-size: 18px; margin-top: 10px; opacity: 0.9;">ممتنون جداً لحضورك وتفاعلك</p>
              </div>
              
              <div style="padding: 45px 35px; background: linear-gradient(to bottom, #ffffff, #fcfcfc);">
                <div style="border-right: 4px solid #ea580c; padding-right: 20px; margin-bottom: 35px;">
                  <h2 style="color: #0f172a; font-size: 20px; margin-top: 0; margin-bottom: 12px;">انطباعنا عن وجودك..</h2>
                  <div style="color: #475569; font-size: 16px; line-height: 1.8; white-space: pre-wrap;">${generatedBody}</div>
                </div>
                
                <div style="background: #fff7ed; padding: 35px; border-radius: 20px; text-align: center; border: 2px dashed #ea580c;">
                  <h3 style="color: #9a3412; font-size: 18px; margin-top: 0; margin-bottom: 10px;">🎯 رأيك يهمنا لنرتقي معاً</h3>
                  <p style="color: #c2410c; margin-bottom: 30px; font-size: 15px;">من فضلك، خذ دقيقة من وقتك لمشاركتنا تقييمك للجلسة وملحوظاتك لنتمكن من تقديم تجارب أفضل دائماً.</p>
                  <a href="${surveyLink}" style="background: #ea580c; color: #ffffff; padding: 18px 45px; text-decoration: none; border-radius: 16px; font-weight: 800; font-size: 16px; display: inline-block; box-shadow: 0 10px 15px -3px rgba(234, 88, 12, 0.3);">إرسال التقييم والملحوظات</a>
                </div>
              </div>

              <div style="padding: 30px; background: #f8fafc; text-align: center; border-top: 1px solid #f1f5f9;">
                <p style="color: #64748b; font-size: 14px; margin: 0; font-weight: 600;">شكراً لكونك جزءاً من مجتمع دروب الطموح ✨</p>
                <div style="margin-top: 15px; font-size: 11px; color: #94a3b8; font-weight: bold; text-transform: uppercase; letter-spacing: 1px;">Doroob | رحلة التغيير تبدأ من هنا</div>
              </div>
            </div>
          `;

          if (transporter && attendee.email) {
            await transporter.sendMail({
              from: `"Doroob Community" <${settings.gmailUser}>`,
              to: attendee.email,
              subject: `ممتنون لحضورك: ${archive.title}`,
              html: emailHtml
            });
            console.log(`Thanks email sent successfully to ${attendee.email}`);
          } else {
            console.warn(`Could not send thanks email to ${attendee.email}. Transporter or email missing.`);
            throw new Error("Transporter or email missing");
          }
          
          results.push({ name: attendee.name, success: true });
        } catch (e: any) {
          console.error(`Failed to send thanks to ${attendee.email}:`, e.message);
          results.push({ name: attendee.name, success: false });
        }
      }

      res.json({ success: true, count: results.filter(r => r.success).length });
    } catch (e) {
      res.status(500).json({ error: "فشل إرسال رسائل الشكر" });
    }
  });

  // Submit Feedback (Disabled - switching to external form)
  /*
  app.post("/api/feedback", async (req, res) => {
    ...
  });
  */

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production" && process.env.VERCEL !== "1") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else if (process.env.VERCEL !== "1") {
    // Standard production (non-vercel)
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }
  // On Vercel, static files are handled by vercel.json and the platform

// Ensure the server starts but doesn't block the export
if (process.env.VERCEL !== "1") {
  const PORT = process.env.PORT || 3000;
  app.listen(Number(PORT), "0.0.0.0", () => {
    console.log(`Server running on port ${PORT}`);
  });
}

export default app;
