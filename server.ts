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
import firebaseConfig from './firebase-applet-config.json' with { type: 'json' };

dotenv.config();

// Initialize Firebase Admin (Preferred for server-side)
if (getApps().length === 0) {
  try {
    // On Vercel, applicationDefault() usually fails unless configured with GOOGLE_APPLICATION_CREDENTIALS
    // We try to use projectId from config first
    if (process.env.VERCEL === "1") {
       console.log("[Firebase Admin] Running on Vercel, skipping applicationDefault due to known issues.");
       initializeApp({ projectId: firebaseConfig.projectId });
    } else {
       initializeApp({
         credential: applicationDefault(),
         projectId: firebaseConfig.projectId || process.env.GOOGLE_CLOUD_PROJECT
       });
       console.log("[Firebase Admin] Initialized with applicationDefault");
    }
  } catch (e: any) {
    console.warn("[Firebase Admin] Init failed, trying basic init:", e.message);
    try { initializeApp({ projectId: firebaseConfig.projectId }); } catch (inner) {}
  }
}

// Initialize Firebase Client SDK as a resilient backup
const clientApp = initializeClientApp(firebaseConfig);
const clientDb = initializeFirestore(clientApp, {
  experimentalForceLongPolling: true
}, firebaseConfig.firestoreDatabaseId || "(default)");
console.log("[Firebase Client SDK] Initialized as backup (Long Polling Enabled)");

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
     console.log(`[Firestore Admin SDK] Initializing - Configured DB ID: ${dbId || "(default)"}`);
     
     // 1. Try explicit databaseId if provided (Priority)
     if (dbId && dbId !== "(default)") {
       try {
         const db = getFirestore(dbId);
         // Heartbeat check with timeout
         await Promise.race([
           db.collection("settings").limit(1).get(),
           new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout")), 2000))
         ]);
         firestore = db;
         console.log(`[Firestore Admin SDK] SUCCESS: Using Configured DB "${dbId}"`);
         return;
       } catch (err: any) {
         console.warn(`[Firestore Admin SDK] Configured DB "${dbId}" check failed:`, err.message);
       }
     }
     
     // 2. Try Default instance (no args)
     try {
       const db = getFirestore();
       // Heartbeat check with timeout
       await Promise.race([
         db.collection("settings").limit(1).get(),
         new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout")), 2000))
       ]);
       firestore = db;
       console.log(`[Firestore Admin SDK] SUCCESS: Using Default DB`);
       return;
     } catch (err: any) {
       console.warn(`[Firestore Admin SDK] Default DB check failed:`, err.message);
     }

     // Final fallback: Use default handle and allow it to fail at call-site or use memDb
     firestore = getFirestore();
     console.log("[Firestore Admin SDK] Falling back to default handle (heartbeat failed).");
  } catch (err: any) {
     console.error("CRITICAL: Firestore initialization error:", err.message);
     firestore = getFirestore();
  }
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

async function startServer() {
  await autoInit();
  const PORT = process.env.PORT || 3000;

  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use(cors());
  app.set('trust proxy', true);

  // Firestore Persistence Helpers (Using Admin SDK)
  const INV_COL = "invitations";
  const SETTINGS_COL = "settings";
  const GLOBAL_SETTINGS_ID = "global";
  const ARCHIVE_COL = "archives";

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

  // Webhook endpoint is removed as per user request

  // Helper to get the correct base URL
  const getBaseUrl = (req: express.Request, settings: any) => {
    // 1. Priority: User-defined settings
    if (settings.publicAppUrl && settings.publicAppUrl.trim() !== '') {
      return settings.publicAppUrl.trim().replace(/\/$/, '');
    }
    
    // 2. Detection (Robust for Cloud Run / Proxies / AI Studio)
    const host = req.get('x-forwarded-host') || req.get('host');
    const protocol = req.get('x-forwarded-proto') || req.protocol || 'https';
    
    if (host) {
      const url = `${protocol}://${host}`;
      console.log(`[getBaseUrl] Detected: ${url} (Host: ${host}, Proto: ${protocol})`);
      return url;
    }

    // 3. Fallback based on environment if detection fails
    const aisUrl = 'https://ais-dev-x27yhjnpefte6r5jvr2jwi-286785108129.europe-west2.run.app';
    return process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : aisUrl;
  };

  const getSettings = async () => {
    try {
      if (firestore) {
        const settingsDoc = await firestore.collection(SETTINGS_COL).doc(GLOBAL_SETTINGS_ID).get();
        if (settingsDoc.exists) {
          const data = settingsDoc.data() || {};
          if (!data.feedbackLink) {
            data.feedbackLink = "https://docs.google.com/forms/d/e/1FAIpQLSf5u5m2p1WvP..." 
          }
          return data;
        }
      }
      
      // Client Fallback if Admin failed or Doc not found in Admin
      const snap = await clientGetDoc(clientDoc(clientDb, SETTINGS_COL, GLOBAL_SETTINGS_ID));
      if (snap.exists()) return snap.data();
      
    } catch (e: any) {
      if (isStorageError(e)) {
        console.log("[Firestore] Admin access denied, trying client fallback for settings.");
        try {
          const snap = await clientGetDoc(clientDoc(clientDb, SETTINGS_COL, GLOBAL_SETTINGS_ID));
          if (snap.exists()) return snap.data();
        } catch (innerE) {
           console.warn("[Firestore] Both Admin and Client failed for settings.");
        }
        return memDb.settings.get(GLOBAL_SETTINGS_ID) || {
          gmailUser: process.env.GMAIL_USER || "",
          gmailPass: process.env.GMAIL_APP_PASSWORD || "",
          hubspotToken: process.env.HUBSPOT_ACCESS_TOKEN || "",
          feedbackLink: "https://docs.google.com/forms/d/e/1FAIpQLSf5u5m2p1WvP..." 
        };
      }
      console.error("Error fetching settings:", e.message);
    }
    return {
      gmailUser: process.env.GMAIL_USER || "",
      gmailPass: process.env.GMAIL_APP_PASSWORD || "",
      hubspotToken: process.env.HUBSPOT_ACCESS_TOKEN || "",
      feedbackLink: "https://docs.google.com/forms/d/e/1FAIpQLSf5u5m2p1WvP..." 
    };
  };

  const saveSettings = async (data: any) => {
    try {
      if (firestore) {
        await firestore.collection(SETTINGS_COL).doc(GLOBAL_SETTINGS_ID).set(data, { merge: true });
        return;
      }
      await clientSetDoc(clientDoc(clientDb, SETTINGS_COL, GLOBAL_SETTINGS_ID), data, { merge: true });
    } catch (e: any) {
      if (isStorageError(e)) {
        console.log("[Firestore] Admin save failed, using Client backup for settings.");
        try {
          await clientSetDoc(clientDoc(clientDb, SETTINGS_COL, GLOBAL_SETTINGS_ID), data, { merge: true });
        } catch (inner) {
          memDb.settings.set(GLOBAL_SETTINGS_ID, data);
        }
      } else {
        console.error("Error saving settings:", e.message);
      }
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
      if (isStorageError(e)) {
        try {
          const snap = await clientGetDoc(clientDoc(clientDb, INV_COL, id));
          return snap.exists() ? snap.data() : memDb.invitations.get(id) || null;
        } catch (inner) {
          return memDb.invitations.get(id) || null;
        }
      }
      console.error(`Error fetching invitation ${id}:`, e.message);
      return null;
    }
  };

  const saveInvitation = async (id: string, data: any) => {
    try {
      if (firestore) {
        await firestore.collection(INV_COL).doc(id).set(data, { merge: true });
        console.log(`[Firestore Admin] Saved invitation: ${id}`);
        return;
      }
      await clientSetDoc(clientDoc(clientDb, INV_COL, id), data, { merge: true });
    } catch (e: any) {
      if (isStorageError(e)) {
        console.log(`[Firestore Client] Backup saving invitation ${id}`);
        try {
          await clientSetDoc(clientDoc(clientDb, INV_COL, id), data, { merge: true });
        } catch (inner) {
          memDb.invitations.set(id, { ...memDb.invitations.get(id), ...data });
        }
      } else {
        console.error(`[Firestore] Error saving invitation ${id}:`, e.message);
      }
    }
  };

  const deleteInvitation = async (id: string) => {
    try {
      memDb.invitations.delete(id);
      if (firestore) {
        try {
          await firestore.collection(INV_COL).doc(id).delete();
          console.log(`[Firestore Admin] Deleted invitation: ${id}`);
          return;
        } catch (e: any) {
          if (!isStorageError(e)) throw e;
        }
      }
      await clientDeleteDoc(clientDoc(clientDb, INV_COL, id));
      console.log(`[Firestore Client] Deleted invitation: ${id}`);
    } catch (e: any) {
      if (!isStorageError(e)) {
        console.error(`[Firestore] Error deleting invitation ${id}:`, e.message);
      }
    }
  };

  const saveArchive = async (id: string, data: any) => {
    try {
      if (firestore) {
        try {
          await firestore.collection(ARCHIVE_COL).doc(id).set(data);
          console.log(`[Firestore Admin] Saved archive: ${id}`);
          return;
        } catch (e: any) {
          if (!isStorageError(e)) throw e;
        }
      }
      await clientSetDoc(clientDoc(clientDb, ARCHIVE_COL, id), data);
      console.log(`[Firestore Client] Saved archive: ${id}`);
    } catch (e: any) {
      if (isStorageError(e)) {
        try {
          await clientSetDoc(clientDoc(clientDb, ARCHIVE_COL, id), data);
        } catch (inner) {
          memDb.archives.set(id, data);
        }
      } else {
        console.error(`[Firestore] Error saving archive ${id}:`, e.message);
      }
    }
  };

  // --- Archives API ---
  const deleteArchive = async (id: string) => {
    try {
      memDb.archives.delete(id);
      if (firestore) {
        try {
          await firestore.collection(ARCHIVE_COL).doc(id).delete();
          console.log(`[Firestore Admin] Deleted archive: ${id}`);
          return;
        } catch (e: any) {
          if (!isStorageError(e)) throw e;
        }
      }
      await clientDeleteDoc(clientDoc(clientDb, ARCHIVE_COL, id));
      console.log(`[Firestore Client] Deleted archive: ${id}`);
    } catch (e: any) {
      if (!isStorageError(e)) {
        console.error(`[Firestore] Error deleting archive ${id}:`, e.message);
      }
    }
  };

  const getAllInvitations = async () => {
    try {
      if (firestore) {
        try {
          const snapshot = await firestore.collection(INV_COL).get();
          console.log(`[Firestore Admin] Retrieved ${snapshot.size} invitations.`);
          return snapshot.docs.map((d: any) => ({ id: d.id, ...d.data() }));
        } catch (e: any) {
          if (!isStorageError(e)) throw e;
        }
      }
      
      const snap = await clientGetDocs(clientCollection(clientDb, INV_COL));
      console.log(`[Firestore Client] Retrieved ${snap.size} invitations.`);
      return snap.docs.map(d => ({ id: d.id, ...d.data() }));

    } catch (e: any) {
      if (isStorageError(e)) {
        try {
          const snap = await clientGetDocs(clientCollection(clientDb, INV_COL));
          return snap.docs.map(d => ({ id: d.id, ...d.data() }));
        } catch (inner) {
          return Array.from(memDb.invitations.values());
        }
      }
      console.error("Error fetching all invitations:", e.message);
      return Array.from(memDb.invitations.values());
    }
  };

  const getAllArchives = async () => {
    try {
      if (firestore) {
        try {
          const snapshot = await firestore.collection(ARCHIVE_COL).get();
          console.log(`[Firestore Admin] Retrieved ${snapshot.size} archives.`);
          return snapshot.docs.map((d: any) => ({ id: d.id, ...d.data() }));
        } catch (e: any) {
          if (!isStorageError(e)) throw e;
        }
      }

      const snap = await clientGetDocs(clientCollection(clientDb, ARCHIVE_COL));
      console.log(`[Firestore Client] Retrieved ${snap.size} archives.`);
      return snap.docs.map(d => ({ id: d.id, ...d.data() }));

    } catch (e: any) {
      if (isStorageError(e)) {
        try {
          const snap = await clientGetDocs(clientCollection(clientDb, ARCHIVE_COL));
          return snap.docs.map(d => ({ id: d.id, ...d.data() }));
        } catch (inner) {
          return Array.from(memDb.archives.values());
        }
      }
      console.error("Error fetching archives:", e.message);
      return Array.from(memDb.archives.values());
    }
  };

  // Gmail Transporter Helper
  const getAiInstance = (settings: any) => {
    const key = settings.geminiApiKey || process.env.CUSTOM_GEMINI_API_KEY || process.env.VITE_CUSTOM_GEMINI_API_KEY || process.env.GEMINI_API_KEY;
    if (key && key.length > 5) {
      return new GoogleGenAI({ apiKey: key });
    }
    return null;
  };

  const getTransporter = async () => {
    const s = await getSettings();
    const user = s.gmailUser || process.env.GMAIL_USER?.trim();
    const pass = s.gmailPass || process.env.GMAIL_APP_PASSWORD?.trim();
    
    if (!user || !pass) return null;

    return nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: user,
        pass: pass,
      },
    });
  };

  const getResend = () => {
    const resendKey = process.env.RESEND_API_KEY?.trim();
    // Only return if it looks like a real key (starts with re_) and isn't a placeholder
    if (resendKey && resendKey.startsWith('re_') && resendKey.length > 20) {
      return new Resend(resendKey);
    }
    return null;
  };

  // API to get settings
  // RSVP Endpoint (Moved early to avoid shadowing)
  app.get("/api/rsvp", async (req, res) => {
    const { id, status } = req.query;
    const clientIp = req.ip || req.get('x-forwarded-for');
    console.log(`[RSVP HIT] ID: ${id}, Status: ${status}, IP: ${clientIp}`);
    
    if (!id) {
      console.warn("[RSVP] Request missing ID");
      return res.status(400).send("<div dir='rtl' style='font-family:sans-serif; text-align:center; padding:50px;'><h1>رابط غير صالح (معرف مفقود).</h1></div>");
    }

    try {
      const record = await getInvitation(id as string);

      if (!record) {
        // Record not found branch
        await saveInvitation(id as string, {
          status: status,
          clickedAt: new Date().toISOString(),
          note: "Record not found during RSVP, possibilities: memory cleared or manual link"
        });

        const title = status === 'yes' ? 'شكراً لك!' : 'نراك لاحقاً';
        const message = status === 'yes' 
          ? `تم تسجيل اهتمامك بالحضور. نسعد بتواجدك معنا!` 
          : `نأسف لعدم تمكنك من الحضور هذه المرة. سنتواصل معك في الجلسات القادمة بإذن الله.`;

        return res.send(`
          <!DOCTYPE html>
          <html lang="ar" dir="rtl">
          <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>${title}</title>
            <link href="https://cdn.jsdelivr.net/npm/tailwindcss@2.2.19/dist/tailwind.min.css" rel="stylesheet">
            <link href="https://fonts.googleapis.com/css2?family=Tajawal:wght@400;700;900&display=swap" rel="stylesheet">
            <style>
              body { font-family: 'Tajawal', sans-serif; background-color: #FDFCFB; }
              .animate-scale { animation: scaleIn 0.5s cubic-bezier(0.16, 1, 0.3, 1); }
              @keyframes scaleIn { from { transform: scale(0.9); opacity: 0; } to { transform: scale(1); opacity: 1; } }
            </style>
          </head>
          <body class="flex items-center justify-center min-h-screen p-4 text-[#1e293b]">
            <div class="max-w-md w-full bg-white rounded-[32px] shadow-2xl p-10 text-center animate-scale border border-orange-100">
              <div class="w-16 h-16 ${status === 'yes' ? 'bg-green-50 text-green-600' : 'bg-red-50 text-red-600'} rounded-2xl flex items-center justify-center mx-auto mb-6">
                ${status === 'yes' ? 
                  '<svg class="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M5 13l4 4L19 7"></path></svg>' : 
                  '<svg class="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M6 18L18 6M6 6l12 12"></path></svg>'
                }
              </div>
              <h1 class="text-2xl font-black mb-4">${title}</h1>
              <p class="text-gray-600 leading-relaxed mb-4">${message}</p>
              <div class="mt-8 pt-6 border-t border-gray-50 uppercase text-[10px] font-black text-gray-300">Doroob Community</div>
            </div>
          </body>
          </html>
        `);
      }

      // Record exists branch
      await saveInvitation(id as string, {
        status: status,
        clickedAt: new Date().toISOString()
      });

      const personName = record.name || "صديق دروب";
      const sessionTitle = record.sessionDetails?.title || "جلسة دروب";

      // Send confirmation email
      const settings = await getSettings();
      if (status === "yes" && settings.gmailUser && settings.gmailPass) {
        try {
          const transporter = await getTransporter();
          if (transporter) {
            await transporter.sendMail({
              from: `"Doroob Community" <${settings.gmailUser}>`,
              to: record.email,
              subject: `تم تأكيد حضورك: ${sessionTitle}`,
              html: `
                <div dir="rtl" style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; text-align: right; color: #1e293b; line-height: 1.8; max-width: 600px; margin: 0 auto; background-color: #ffffff; border: 1px solid #f1f5f9; border-radius: 20px; overflow: hidden; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.05);">
                  <div style="background-color: #10b981; padding: 30px 20px; text-align: center;">
                    <h1 style="color: #ffffff; margin: 0; font-size: 22px; font-weight: 800;">تم تأكيد حضورك بنجاح!</h1>
                  </div>
                  <div style="padding: 40px 30px;">
                    <p style="font-size: 18px; margin-bottom: 20px;">مرحباً <strong>${personName}</strong>،</p>
                    <p style="color: #475569; font-size: 16px; margin-bottom: 25px;">
                      نحن متحمسون لرؤيتك في جلسة <strong>${sessionTitle}</strong>. تم حجز مقعدك بنجاح، ونتطلع لمشاركتك القيمة.
                    </p>
                    <div style="background: #f0fdf4; padding: 20px; border-radius: 12px; border: 1px solid #dcfce7; text-align: center;">
                      <p style="color: #166534; font-weight: bold; margin: 0;">نراك قريباً في دروب!</p>
                    </div>
                  </div>
                  <div style="background-color: #f8fafc; padding: 20px; text-align: center; border-top: 1px solid #f1f5f9;">
                    <p style="color: #94a3b8; font-size: 12px; margin: 0;">مجتمع دروب (Doroob Community)</p>
                  </div>
                </div>
              `
            });
          }
        } catch (mailError) {
          console.error("Confirmation email failed:", mailError);
        }
      }

      const title = status === 'yes' ? 'شكراً لك!' : 'نراك لاحقاً';
      const message = status === 'yes' 
        ? `تم تسجيل حضورك بنجاح في جلسة <b>${sessionTitle}</b>. نسعد بتواجدك معنا!` 
        : `نأسف لعدم تمكنك من الحضور هذه المرة. سنتواصل معك في الجلسات القادمة بإذن الله.`;

      return res.send(`
        <!DOCTYPE html>
        <html lang="ar" dir="rtl">
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>${title}</title>
          <link href="https://cdn.jsdelivr.net/npm/tailwindcss@2.2.19/dist/tailwind.min.css" rel="stylesheet">
          <link href="https://fonts.googleapis.com/css2?family=Tajawal:wght@400;700;900&display=swap" rel="stylesheet">
          <style>
            body { font-family: 'Tajawal', sans-serif; background-color: #FDFCFB; }
            .animate-scale { animation: scaleIn 0.5s cubic-bezier(0.16, 1, 0.3, 1); }
            @keyframes scaleIn { from { transform: scale(0.9); opacity: 0; } to { transform: scale(1); opacity: 1; } }
          </style>
        </head>
        <body class="flex items-center justify-center min-h-screen p-4 text-[#1e293b]">
          <div id="mismatch-card" class="hidden max-w-md w-full bg-white rounded-[32px] shadow-2xl p-10 text-center animate-scale border border-red-100">
             <div class="w-20 h-20 bg-red-50 rounded-3xl flex items-center justify-center mx-auto mb-8">
               <svg class="w-10 h-10 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"></path></svg>
             </div>
             <h1 class="text-2xl font-black mb-4">هذه الدعوة مخصصة لزميل آخر</h1>
             <p class="text-gray-600 mb-8 leading-relaxed">بينما أُرسلت هذه الدعوة حصرياً إلى: <br> <span class="font-bold">${record.email}</span></p>
             <a href="https://accounts.google.com/Logout" class="block w-full py-4 bg-gray-900 text-white rounded-2xl font-bold">تبديل الحساب</a>
          </div>
          <div id="main-card" class="max-w-md w-full bg-white rounded-[32px] shadow-2xl p-10 text-center animate-scale border border-orange-100 relative">
            <div class="w-20 h-20 ${status === 'yes' ? 'bg-green-50 text-green-600' : 'bg-red-50 text-red-600'} rounded-3xl flex items-center justify-center mx-auto mb-8 shadow-inner">
               ${status === 'yes' ? '<svg class="w-10 h-10" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M5 13l4 4L19 7"></path></svg>' : '<svg class="w-10 h-10" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M6 18L18 6M6 6l12 12"></path></svg>'}
            </div>
            <h1 class="text-3xl font-black mb-4">${title}</h1>
            <p class="text-gray-600 text-lg mb-10 leading-relaxed">${message}</p>
            <div class="mt-10 pt-8 border-t border-gray-50 uppercase text-[10px] font-black text-gray-300">Doroob Community</div>
          </div>
          <script type="module">
            import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
            import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
            const firebaseConfig = ${JSON.stringify(firebaseConfig)};
            const app = initializeApp(firebaseConfig);
            const auth = getAuth(app);
            const targetEmail = "${record.email.toLowerCase()}";
            onAuthStateChanged(auth, (user) => {
              if (user && user.email && user.email.toLowerCase() !== targetEmail) {
                document.getElementById('main-card').classList.add('hidden');
                document.getElementById('mismatch-card').classList.remove('hidden');
              }
            });
          </script>
        </body>
        </html>
      `);
    } catch (error: any) {
      console.error("RSVP Critical Error:", error.message);
      res.status(500).send("<h1>حدث خطأ أثناء معالجة طلبك.</h1>");
    }
  });

  app.get("/api/settings", async (req, res) => {
    const s = await getSettings();
    res.json({
      gmailUser: s.gmailUser || process.env.GMAIL_USER || "",
      gmailPass: s.gmailPass || process.env.GMAIL_APP_PASSWORD || "",
      hubspotToken: s.hubspotToken || process.env.HUBSPOT_ACCESS_TOKEN || "",
      publicAppUrl: s.publicAppUrl || "",
      geminiApiKey: s.geminiApiKey || "",
      feedbackLink: s.feedbackLink || ""
    });
  });

  // API to update settings
  app.post("/api/settings", async (req, res) => {
    const { gmailUser, gmailPass, hubspotToken, publicAppUrl, geminiApiKey, feedbackLink } = req.body;
    const current = await getSettings();
    const updated = {
      gmailUser: gmailUser !== undefined ? gmailUser : current.gmailUser,
      gmailPass: gmailPass !== undefined ? gmailPass : current.gmailPass,
      hubspotToken: hubspotToken !== undefined ? hubspotToken : current.hubspotToken,
      publicAppUrl: publicAppUrl !== undefined ? publicAppUrl : current.publicAppUrl,
      geminiApiKey: geminiApiKey !== undefined ? geminiApiKey : current.geminiApiKey,
      feedbackLink: feedbackLink !== undefined ? feedbackLink : current.feedbackLink
    };
    await saveSettings(updated);
    res.json({ success: true });
  });

  app.delete("/api/archives/:id", async (req, res) => {
    const { id } = req.params;
    try {
      await deleteArchive(id);
      res.json({ success: true });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Send Custom Mail (for AI replies)
  app.post("/api/mail/send-custom", async (req, res) => {
    const { to, subject, body } = req.body;
    const settings = await getSettings();

    if (!settings.gmailUser || !settings.gmailPass) {
      return res.status(401).json({ error: "Email settings not configured" });
    }

    try {
      const transporter = await getTransporter();
      if (!transporter) throw new Error("Could not initialize mail transporter");

      await transporter.sendMail({
        from: `"Doroob Community" <${settings.gmailUser}>`,
        to,
        subject,
        html: `
          <div dir="rtl" style="font-family: sans-serif; text-align: right; color: #1e293b; line-height: 1.6; padding: 20px;">
            <div style="border-right: 4px solid #ea580c; padding-right: 20px; white-space: pre-wrap;">
              ${body}
            </div>
            <div style="margin-top: 30px; padding-top: 20px; border-top: 1px solid #f1f5f9; color: #94a3b8; font-size: 0.8em;">
              تم إرسال هذا الرد عبر نظام المساعد الذكي لمجتمع دروب.
            </div>
          </div>
        `,
      });

      res.json({ success: true });
    } catch (error: any) {
      console.error("Send custom mail error:", error);
      res.status(500).json({ error: error.message });
    }
  });

  // HubSpot Token Helper
  const getHubSpotToken = async () => {
    const s = await getSettings();
    let token = s.hubspotToken || process.env.HUBSPOT_ACCESS_TOKEN;
    if (token) {
      token = token.trim()
        .replace(/^["'](.+)["']$/, '$1')
        .replace(/[\u200B-\u200D\uFEFF]/g, '');
    }
    return token;
  };

  // Search HubSpot contacts by topic
  app.get("/api/gemini/health", (req, res) => {
    const key = process.env.CUSTOM_GEMINI_API_KEY || process.env.VITE_CUSTOM_GEMINI_API_KEY || process.env.GEMINI_API_KEY;
    if (key && key.length > 5) {
      res.json({ status: "ok" });
    } else {
      res.json({ status: "missing" });
    }
  });

  // Search HubSpot contacts by topic
  app.post("/api/hubspot/search", async (req, res) => {
    const accessToken = await getHubSpotToken();
    
    if (!accessToken || accessToken === "pat-na1-..." || accessToken === "") {
      return res.status(401).json({ 
        error: "HUBSPOT_ACCESS_TOKEN غير متوفر",
        details: "يرجى التأكد من إضافة HUBSPOT_ACCESS_TOKEN في خيار Secrets في AI Studio."
      });
    }

    const { topic, keywords } = req.body;
    const searchTerms = keywords && Array.isArray(keywords) ? keywords : [topic];

    try {
      if (searchTerms.length === 0 || !searchTerms[0]) {
        return res.status(400).json({ 
          error: "الموضوع مطلوب",
          details: "يرجى إدخال موضوع الجلسة للبحث."
        });
      }

      // Search HubSpot for each keyword (sequentially to avoid rate limits)
      const candidates = [];
      const limitedSearchTerms = searchTerms.slice(0, 15);
      
      for (const keyword of limitedSearchTerms) {
        if (!keyword || keyword.length < 2) continue;
        
        try {
          const fetchSearch = async (body: any) => {
            const res = await fetch("https://api.hubapi.com/crm/v3/objects/contacts/search", {
              method: "POST",
              headers: { "Content-Type": "application/json", "Authorization": `Bearer ${accessToken}` },
              body: JSON.stringify(body)
            });
            if (res.status === 429) {
               // Wait a bit if rate limited
               await new Promise(resolve => setTimeout(resolve, 1000));
               return fetchSearch(body); 
            }
            if (!res.ok) {
              const text = await res.text();
              console.error(`HubSpot Search sub-query failed: ${res.status}`, text);
              return { results: [] };
            }
            return res.json();
          };

          // 1. Broad query search (HubSpot handles this fuzzy/partial)
          const res1 = await fetchSearch({
            query: keyword,
            properties: ["firstname", "lastname", "email", "jobtitle", "company", "phone", "role", "summary"],
            limit: 100,
          });
          if (res1.results) candidates.push(...res1.results);

          // 2. Targeted search for specific fields with CONTAINS_TOKEN
          const res2 = await fetchSearch({
            filterGroups: [
              { filters: [{ propertyName: "summary", operator: "CONTAINS_TOKEN", value: `*${keyword}*` }] },
              { filters: [{ propertyName: "jobtitle", operator: "CONTAINS_TOKEN", value: `*${keyword}*` }] },
              { filters: [{ propertyName: "role", operator: "CONTAINS_TOKEN", value: `*${keyword}*` }] }
            ],
            properties: ["firstname", "lastname", "email", "jobtitle", "company", "phone", "role", "summary"],
            limit: 50,
          });
          if (res2.results) candidates.push(...res2.results);
          
          await new Promise(resolve => setTimeout(resolve, 200));
        } catch (e) {
          console.error("Search fetch error for keyword:", keyword, e);
        }
      }

      // Deduplicate and calculate priority scores
      const uniqueContactsMap = new Map();
      candidates.forEach(c => {
        if (!uniqueContactsMap.has(c.id)) {
          let score = 0;
          const summary = (c.properties.summary || '').toLowerCase();
          const role = (c.properties.role || '').toLowerCase();
          const jobTitle = (c.properties.jobtitle || '').toLowerCase();
          const company = (c.properties.company || '').toLowerCase();
          
          // Primary check using all keywords to score relevance
          keywords.forEach(k => {
            const kw = k.toLowerCase();
            if (summary.includes(kw)) score += 20; // High priority for summary
            if (role.includes(kw)) score += 10;
            if (jobTitle.includes(kw)) score += 5;
            if (company.includes(kw)) score += 2;
          });
          
          uniqueContactsMap.set(c.id, { ...c, score });
        }
      });

      const sortedCandidates = Array.from(uniqueContactsMap.values())
        .sort((a, b) => b.score - a.score);

      res.json(sortedCandidates.slice(0, 100));
    } catch (error: any) {
      const hubspotErrorBody = error.response?.body;
      console.error("HubSpot API Error Details:", JSON.stringify(hubspotErrorBody || error.message));
      
      let message = "فشل الاتصال بـ HubSpot";
      let details = hubspotErrorBody?.message || error.message;

      if (hubspotErrorBody?.errors && Array.isArray(hubspotErrorBody.errors)) {
        const subErrors = hubspotErrorBody.errors.map((e: any) => e.message).join(" | ");
        details = `${details} (${subErrors})`;
      }

      if (error.response?.statusCode === 401) {
        message = "خطأ في التوكن (401 Unauthorized)";
        details = "HubSpot لم يتعرف على التوكن. تأكد من أنك نسخت الـ 'Access Token' (بدقة وبدون مسافات إضافية) من صفحة الـ Private App في HubSpot وضبطته في Secrets باسم HUBSPOT_ACCESS_TOKEN.";
      } else if (error.response?.statusCode === 403) {
        message = "خطأ في الصلاحيات (403 Forbidden)";
        details = "تأكد من اختيار كافة الـ Scopes المطلوبة (مثل crm.objects.contacts.read) عند إنشاء Private App في HubSpot.";
      } else if (error.response?.statusCode === 400) {
        message = "خطأ في طلب البيانات (400 Bad Request)";
        details = "هناك مشكلة في صيغة البحث المرسلة إلى HubSpot. يرجى مراجعة البيانات المدخلة.";
      } else if (error.response?.statusCode === 404) {
        message = "المصدر غير موجود (404)";
        details = "نقطة الاتصال في HubSpot غير موجودة أو العنوان غير صحيح.";
      }

      res.status(error.response?.statusCode || 500).json({ 
        error: message,
        details: details
      });
    }
  });

  // Health check for HubSpot
  app.get("/api/hubspot/health", async (req, res) => {
    const accessToken = await getHubSpotToken();
    if (!accessToken) return res.json({ status: "missing_token" });
    
    try {
      const hubspotRes = await fetch("https://api.hubapi.com/crm/v3/objects/contacts?limit=1", {
        headers: { "Authorization": `Bearer ${accessToken}` }
      });
      const data = await hubspotRes.json();
      res.json({ status: hubspotRes.ok ? "ok" : "error", code: hubspotRes.status, data });
    } catch (error: any) {
      res.json({ status: "error", error: error.message });
    }
  });

  // Health check for Firestore
  app.get("/api/firestore/health", async (req, res) => {
    try {
      if (!firestore) return res.json({ status: "error", error: "firestore is undefined" });
      
      const snap = await firestore.collection("invitations").limit(1).get();
      
      res.json({ 
        status: "ok", 
        docsFound: snap.size,
        databaseId: (firestore as any)._databaseId?.database || "unknown",
        config: {
          projectId: firebaseConfig.projectId,
          configDatabaseId: firebaseConfig.firestoreDatabaseId
        }
      });
    } catch (error: any) {
      console.error("Firestore Health Check Failed:", error);
      res.json({ 
        status: "error", 
        message: error.message, 
        code: error.code,
        projectId: firebaseConfig.projectId,
        databaseId: firebaseConfig.firestoreDatabaseId,
        suggest: "If PERMISSION_DENIED, ensure the project allows the current service account."
      });
    }
  });

  // Fetch HubSpot Account Info
  app.get("/api/hubspot/account", async (req, res) => {
    const accessToken = await getHubSpotToken();
    if (!accessToken) return res.status(401).json({ error: "Missing token" });

    try {
      // Get portal/account details
      const hubspotRes = await fetch("https://api.hubapi.com/account-info/v3/details", {
        headers: { "Authorization": `Bearer ${accessToken}` }
      });
      const data = await hubspotRes.json();
      res.json(data);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Fetch recent HubSpot contacts
  app.get("/api/hubspot/contacts", async (req, res) => {
    const accessToken = await getHubSpotToken();
    if (!accessToken) return res.status(401).json({ error: "Missing token" });

    try {
      const fetchWithProps = async (props: string[]) => {
        return fetch(`https://api.hubapi.com/crm/v3/objects/contacts?limit=100&properties=${props.join(",")}`, {
          headers: { "Authorization": `Bearer ${accessToken}` }
        });
      };

      let hubspotRes = await fetchWithProps(["firstname", "lastname", "email", "jobtitle", "company", "phone", "role", "summary"]);
      
      if (!hubspotRes.ok && hubspotRes.status === 400) {
        hubspotRes = await fetchWithProps(["firstname", "lastname", "email", "jobtitle", "company", "phone"]);
      }

      if (!hubspotRes.ok) throw new Error(`HubSpot API error: ${hubspotRes.status}`);
      
      const data = await hubspotRes.json();
      res.json(data.results || []);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Send Invitations
  app.post("/api/invitations/send", async (req, res) => {
    const { contacts, sessionDetails } = req.body;
    
    if (!contacts || !Array.isArray(contacts)) {
      return res.status(400).json({ error: "Invalid or missing contacts list" });
    }
    
    if (!sessionDetails) {
      return res.status(400).json({ error: "Missing session details" });
    }

    const results = [];
    const settings = await getSettings();

    for (const contact of contacts) {
      // Better random ID generation
      const inviteId = Math.random().toString(36).substring(2, 15);
      
      const baseAppUrl = getBaseUrl(req, settings);
      const inviteLink = `${baseAppUrl}/api/rsvp?id=${inviteId}`;
      const appUrl = baseAppUrl;
      console.log(`Generating invitation. Host: ${req.get('host')}, Forwarded: ${req.get('x-forwarded-host')}, Final appUrl: ${appUrl}`);
      
      const emailContent = `
        <div dir="rtl" style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; text-align: right; color: #1e293b; line-height: 1.8; max-width: 600px; margin: 0 auto; background-color: #ffffff; border: 1px solid #f1f5f9; border-radius: 20px; overflow: hidden; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.05);">
          <div style="background-color: #ea580c; padding: 40px 20px; text-align: center;">
            <h1 style="color: #ffffff; margin: 0; font-size: 24px; font-weight: 800; letter-spacing: -0.5px;">فرصة جديدة للنمو: ${sessionDetails?.title || "جلسة دروب"}</h1>
            <p style="color: #ffedd5; margin-top: 10px; font-size: 16px;">دروب | رحلة التغيير تبدأ من هنا</p>
          </div>
          
          <div style="padding: 40px 30px;">
            <p style="font-size: 18px; margin-bottom: 20px;">مرحباً <strong>${contact.properties.firstname || 'صديق دروب'}</strong>،</p>
            
            <p style="color: #475569; font-size: 16px; margin-bottom: 30px;">
              في <strong>مجتمع دروب</strong>، نؤمن بأن المعرفة هي حجر الأساس، وأن التجارب المشتركة هي التي تصنع الفرق. بصفتك أحد الأعضاء الذين نعتز بوجودهم في رادارنا، يسعدنا دعوتك شخصياً لجلسة <strong>"${sessionDetails?.title || "جلسة دروب"}"</strong>.
            </p>
            
            <div style="background: #fffafa; padding: 25px; border-radius: 16px; border-right: 5px solid #ea580c; margin-bottom: 40px;">
              <h3 style="color: #ea580c; font-size: 18px; margin-top: 0; margin-bottom: 15px;">ماذا بانتظارك؟</h3>
              <p style="margin: 8px 0; font-size: 15px;">📅 <strong>التاريخ:</strong> ${sessionDetails.date || 'سيتم التنسيق قريباً'}</p>
              <p style="margin: 8px 0; font-size: 15px;">⏰ <strong>الوقت:</strong> ${sessionDetails.time || '—'}</p>
              <p style="margin: 8px 0; font-size: 15px;">
                📍 <strong>الموقع:</strong> 
                <a href="${sessionDetails.locationLink || '#'}" style="color: #ea580c; font-weight: bold; text-decoration: underline;">
                  ${sessionDetails.locationName || sessionDetails.location || 'مقر الجلسة'}
                </a>
              </p>
            </div>

            <div style="text-align: center;">
              <p style="font-weight: bold; color: #1e293b; margin-bottom: 25px; font-size: 18px;">المقاعد تكتمل بسرعة.. كن أول المنضمين!</p>
              
              <div style="margin-bottom: 20px;">
                <a href="${inviteLink}&status=yes" 
                   style="background: #ea580c; color: #ffffff; padding: 18px 50px; text-decoration: none; border-radius: 16px; font-weight: 800; font-size: 16px; box-shadow: 0 10px 15px -3px rgba(234, 88, 12, 0.4); display: inline-block;">تأكيد الحضور والمشاركة</a>
              </div>
              
              <div>
                <a href="${inviteLink}&status=no" 
                   style="color: #94a3b8; text-decoration: none; font-size: 14px; font-weight: 600; text-decoration: underline;">نأسف، لا أستطيع الحضور هذه المرة</a>
              </div>
            </div>
          </div>
          
          <div style="background-color: #f8fafc; padding: 30px; text-align: center; border-top: 1px solid #f1f5f9;">
            <p style="color: #64748b; font-size: 14px; margin: 0;">شكراً لكونك جزءاً من مجتمعنا الطموح.</p>
            <p style="color: #94a3b8; font-size: 12px; margin-top: 5px;">فريق مجتمع دروب (Doroob Community)</p>
          </div>
        </div>
      `;

      try {
        let sentStatus = "simulated";
        let messageId = null;
        let provider = "none";
        
        // 1. Try Resend first (only if key seems valid)
        const resend = getResend();
        if (resend && contact.properties.email) {
          try {
            const { data, error } = await resend.emails.send({
              from: 'Doroob Community <onboarding@resend.dev>',
              to: contact.properties.email.trim(),
              subject: `دعوة حصرية: ${sessionDetails?.title || "جلسة دروب"}`,
              html: emailContent,
            });
            
            if (error) {
              // If it's a validation error or invalid API key, we log gently and fallback
              const isCritical = error.name !== 'validation_error' && !error.message?.includes('API key');
              if (isCritical) {
                console.warn("Resend attempt failed:", error);
              }
              throw error; 
            }
            
            sentStatus = "sent";
            messageId = data?.id;
            provider = "resend";
          } catch (resendError: any) {
            // Silently fallback to Gmail
            if (resendError.name !== 'validation_error' && !resendError.message?.includes('API key')) {
              console.log("Resend skipped/failed, using Gmail fallback.");
            }
          }
        }

        // 2. Fallback to Gmail if Resend failed or wasn't configured
        const settings = await getSettings();
        if (sentStatus === "simulated" && settings.gmailUser && settings.gmailPass) {
          try {
            const transporter = await getTransporter();
            const info = await transporter.sendMail({
              from: `"Doroob Community" <${settings.gmailUser}>`,
              to: contact.properties.email,
              subject: `دعوة: ${sessionDetails?.title || "جلسة دروب"}`,
              html: emailContent,
            });
            sentStatus = "sent";
            messageId = info.messageId;
            provider = "gmail";
          } catch (gmailError: any) {
            console.error("Gmail error:", gmailError.message);
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
                model: "gemini-1.5-flash",
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
  } else {
    // In production (Vercel or standard), serve static files
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      const filePath = path.join(distPath, req.path);
      if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        res.sendFile(filePath);
      } else {
        res.sendFile(path.join(distPath, "index.html"));
      }
    });
  }

  // Only listen if not on Vercel
  if (process.env.VERCEL !== "1") {
    app.listen(Number(PORT), "0.0.0.0", () => {
      console.log(`Server running on port ${PORT}`);
    });
  }
}

// Ensure the server starts but doesn't block the export
startServer().catch(err => {
  console.error("Critical error during server start:", err);
});

export default app;
