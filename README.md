# نظام إدارة دعوات مجتمع دروب (Doroob Community)

نظام متكامل لإدارة دعوات الفعاليات، البحث عن المهتمين عبر HubSpot، وإرسال الدعوات عبر Gmail/Resend مع تتبع الحضور بنظام QR Code.

## 🚀 كيفية التشغيل والرفع

### 1. المتطلبات الأولية
- حساب على [HubSpot](https://www.hubspot.com/) (Private App Access Token).
- حساب Gmail (مع تفعيل App Password إذا كان الحساب محمياً بخطوتين).
- مفتاح API لـ [Gemini](https://aistudio.google.com/) (للبحث الذكي).

### 2. إعداد البيئة (Variables)
قم بإنشاء ملف `.env` في المجلد الرئيسي وأضف المتغيرات التالية. 
**هام جداً:** المتغيرات التي تبدأ بـ `VITE_` هي فقط التي يمكن للواجهة الأمامية (App.tsx) الوصول إليها.

```env
# HubSpot (Server Side Only)
HUBSPOT_ACCESS_TOKEN=your_token_here

# Gemini (AI)
VITE_CUSTOM_GEMINI_API_KEY=your_gemini_key_here
CUSTOM_GEMINI_API_KEY=your_gemini_key_here

# Gmail (لإرسال الدعوات)
GMAIL_USER=your_email@gmail.com
GMAIL_PASS=your_app_password

# الإعدادات العامة
PORT=3000
NODE_ENV=production
```

### 3. التثبيت والتشغيل
للتشغيل محلياً أو على سيرفر خاص:
```bash
# تثبيت المكتبات
npm install

# بناء ملفات الواجهة الأمامية
npm run build

# تشغيل التطبيق (الخادم والواجهة معاً)
npm start
```

## 🛠 التكنولوجيا المستخدمة
- **الواجهة:** React, Tailwind CSS, Motion (Animations), Lucide Icons.
- **الخادم:** Express.js, TypeScript (tsx).
- **التكاملات:** HubSpot CRM, Google Gemini AI, Nodemailer.

## 📂 هيكلة الملفات
- `server.ts`: الخادم الرئيسي والـ API (HubSpot, Mail, RSVP).
- `src/App.tsx`: الواجهة الرئيسية للوحة التحكم.
- `pending_replies.json`: قاعدة بيانات بسيطة لتتبع الدعوات والردود.
- `settings.json`: تخزين الإعدادات الخاصة بـ HubSpot و Gmail.

### 4. الرفع على Vercel
تم ربط التطبيق بـ **Firebase Firestore** لضمان حفظ البيانات بشكل دائم حتى عند استخدام Vercel.

تأكد من إضافة المتغيرات التالية في إعدادات المشروع (Settings > Environment Variables):
- `VITE_CUSTOM_GEMINI_API_KEY` (للوصول من الواجهة الأمامية)
- `CUSTOM_GEMINI_API_KEY` (للوصول من السيرفر)
- `HUBSPOT_ACCESS_TOKEN` (للسيرفر)
- `GMAIL_USER` (بريدك الإلكتروني)
- `GMAIL_PASS` (كلمة مرور التطبيقات - App Password)
- `NODE_ENV` = `production`

**ملاحظة تقنية:** يعتمد التطبيق حالياً على Firebase لتخزين الدعوات والإعدادات، مما يجعله جاهزاً للعمل في البيئات السحابية (Serverless) دون فقدان للبيانات.

---
تم التطوير ليكون بوابة ذكية لربط أعضاء مجتمع دروب.
