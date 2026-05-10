import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { 
  Users, Mail, Search, Send, Settings, LogOut, LayoutDashboard, 
  ChevronDown, Sparkles, Loader2, Calendar, Clock, 
  MapPin, Navigation, Eye, EyeOff, AlertCircle, CheckCircle2, 
  Copy, RotateCcw, Share2, MessageSquare, Phone, ShieldCheck, 
  Plus, Trash2, Globe, Download, Star, UserPlus
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { GoogleGenAI, Type } from "@google/genai";

// Standard Doroob Branding
const DOROOB_SERVICES = `
Doroob Community Services: 
1. Professional Networking
2. Technical Workshops
3. Soft Skills Training
4. Career Mentorship
5. Tech News & Updates
`;

interface Contact {
  id: string;
  properties: {
    firstname: string;
    lastname: string;
    email: string;
    jobtitle?: string;
    company?: string;
    phone?: string;
    role?: string;
    summary?: string;
  };
}

interface Invitation {
  id: string;
  name: string;
  email: string;
  sentAt: string;
  status: 'pending' | 'yes' | 'no' | 'sent';
  provider: 'gmail' | 'resend' | 'none';
  mode?: string;
  clickedAt?: string;
  checkedInAt?: string;
  attendance?: 'attended' | 'absent' | null;
  checkInMethod?: string;
  sessionDetails: {
    title: string;
    date: string;
    time: string;
    locationName: string;
    locationLink: string;
  };
}

interface AppSettings {
  gmailUser: string;
  gmailPass: string;
  hubspotToken: string;
  publicAppUrl: string;
  geminiApiKey: string;
  feedbackLink: string;
}

interface Archive {
  id: string;
  title: string;
  sessionDate: string;
  archivedAt: string;
  totalInvited: number;
  confirmedAttending: number;
  attendedCount: number;
  confirmedButAbsent: number;
  apologizedCount: number;
  noResponseCount: number;
  notes: string;
  invitationIds: string[];
  newGuests?: { name: string; email: string; phone?: string }[];
}

interface Application {
  id: string;
  name: string;
  email: string;
  phone?: string;
  jobTitle?: string;
  company?: string;
  role?: string;
  summary?: string;
  receivedAt: string;
  status: 'pending' | 'accepted' | 'rejected';
}

const getAi = (key: string) => {
  return new GoogleGenAI({ apiKey: key });
};

export default function App() {
  const [activeTab, setActiveTab] = useState('dashboard');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [topic, setTopic] = useState('');
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [allContacts, setAllContacts] = useState<Contact[]>([]);
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingContacts, setLoadingContacts] = useState(false);
  const [sending, setSending] = useState(false);
  const [status, setStatus] = useState<{ type: 'success' | 'error', message: string } | null>(null);
  const [accountInfo, setAccountInfo] = useState<any>(null);
  const [connectionStatus, setConnectionStatus] = useState<'ok' | 'error' | 'missing'>('ok');
  const [aiConnectionStatus, setAiConnectionStatus] = useState<'ok' | 'missing'>('missing');
  const [settingsLoading, setSettingsLoading] = useState(false);
  const [showOverview, setShowOverview] = useState(false);
  const [invitationFilter, setInvitationFilter] = useState('all');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deletingArchiveId, setDeletingArchiveId] = useState<string | null>(null);
  const [archives, setArchives] = useState<Archive[]>([]);
  const [archiving, setArchiving] = useState(false);
  const [sendingThanksId, setSendingThanksId] = useState<string | null>(null);
  const [showArchiveNotesModal, setShowArchiveNotesModal] = useState(false);
  const [archiveNotes, setArchiveNotes] = useState('');

  useEffect(() => {
    if (status) {
      const timer = setTimeout(() => setStatus(null), 3000);
      return () => clearTimeout(timer);
    }
  }, [status]);

  const [settings, setSettings] = useState<AppSettings>({
    gmailUser: '',
    gmailPass: '',
    hubspotToken: '',
    publicAppUrl: '',
    geminiApiKey: '',
    feedbackLink: ''
  });

  const [sessionDetails, setSessionDetails] = useState({
    title: '',
    date: '2026-05-01',
    time: '8:00PM-11:30PM',
    locationName: 'العمارية - منتجع انغامي',
    locationLink: 'https://www.google.com/maps/place/RDYA5787%D8%8C+5787+%D8%A7%D9%84%D8%B9%D9%85%D8%A7%D8%B1%D9%8A%D9%87+335%D8%8C+6705%D8%8C+%D8%A7%D9%84%D8%B9%D9%85%D8%A7%D8%B1%D9%8A%D8%A9+13728%E2%80%AD/@24.7569706,46.4330354,16z/data=!4m6!3m5!1s0x3e2edb8c26cdc3bd:0x8c42f4d274503a4c!8m2!3d24.7569706!4d46.4330354!16s%2Fg%2F11vjlx38fr?g_ep=Eg1tbF8yMDI2MDQyOV8wIJvbDyoASAJQAg%3D%3D'
  });

  const [showGmailPass, setShowGmailPass] = useState(false);
  const [showHubspotToken, setShowHubspotToken] = useState(false);

  // Filters & Search
  const [resultsSearch, setResultsSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState('all');
  const [overviewSearch, setOverviewSearch] = useState('');
  const [overviewRoleFilter, setOverviewRoleFilter] = useState('all');

  // AI Assistant State
  const [inquiry, setInquiry] = useState('');
  const [aiReply, setAiReply] = useState('');
  const [aiLoading, setAiLoading] = useState(false);
  const [recipientEmail, setRecipientEmail] = useState('');
  const [mailSending, setMailSending] = useState(false);
  const [isSmartSearch, setIsSmartSearch] = useState(true);

  useEffect(() => {
    fetchSettings();
    fetchOverview();
    refreshInvitations();
    checkAiHealth();
    fetchArchives();
  }, []);

  const [draftingArchiveId, setDraftingArchiveId] = useState<string | null>(null);

  const sendThanksToAttendees = async (archiveId: string) => {
    setSendingThanksId(archiveId);
    try {
      const res = await fetch(`/api/archives/${archiveId}/send-thanks`, {
        method: 'POST'
      });
      if (res.ok) {
        const data = await res.json();
        setStatus({ type: 'success', message: `تم إرسال ${data.count} رسالة شكر وتقييم بنجاح` });
      } else {
        const err = await res.json();
        setStatus({ type: 'error', message: err.error || 'فشل إرسال رسائل الشكر' });
      }
    } catch (e) {
      setStatus({ type: 'error', message: 'تعذر الاتصال بالسيرفر لإرسال الشكر' });
    } finally {
      setSendingThanksId(null);
    }
  };

  const fetchArchives = async () => {
    try {
      const res = await fetch('/api/archives');
      if (res.ok) {
        const data = await res.json();
        setArchives(Array.isArray(data) ? data.sort((a: Archive, b: Archive) => new Date(b.archivedAt).getTime() - new Date(a.archivedAt).getTime()) : []);
      }
    } catch (e) {
      console.error("Archives fetch error:", e);
    }
  };

  const deleteArchive = async (id: string) => {
    try {
      const res = await fetch(`/api/archives/${id}`, { method: 'DELETE' });
      if (res.ok) {
        setArchives(prev => prev.filter(a => a.id !== id));
        setStatus({ type: 'success', message: 'تم حذف الأرشيف بنجاح' });
      }
    } catch (e) {
      setStatus({ type: 'error', message: 'فشل حذف الأرشيف' });
    }
  };

  const fetchSettings = async () => {
    try {
      const res = await fetch('/api/settings');
      if (res.ok) {
        const data = await res.json();
        setSettings(data);
      }
    } catch (e) {
      console.error("Settings fetch error:", e);
    }
  };

  const updateSettings = async () => {
    setSettingsLoading(true);
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings),
      });
      if (res.ok) {
        const data = await res.json();
        let storageMsg = ' (محفوظ في قاعدة البيانات)';
        if (data.type === 'memory') storageMsg = ' (محفوظ في الذاكرة المؤقتة فقط - لن يستمر بعد إعادة التشغيل)';
        setStatus({ type: 'success', message: 'تم حفظ الإعدادات بنجاح' + storageMsg });
        checkAiHealth();
      } else {
        const errorData = await res.json().catch(() => ({}));
        setStatus({ 
          type: 'error', 
          message: `فشل حفظ الإعدادات: ${errorData.error || res.statusText || 'خطأ غير معروف'}` 
        });
      }
    } catch (e: any) {
      console.error("Update settings error:", e);
      setStatus({ type: 'error', message: 'فشل الاتصال بالسيرفر لحفظ الإعدادات' });
    } finally {
      setSettingsLoading(false);
    }
  };

  const checkAiHealth = async () => {
    try {
      const res = await fetch('/api/gemini/health');
      const data = await res.json();
      setAiConnectionStatus(data.status);
    } catch (e) {
      setAiConnectionStatus('missing');
    }
  };

  const fetchOverview = async () => {
    try {
      const [accRes, contactsRes] = await Promise.all([
        fetch('/api/hubspot/account'),
        fetch('/api/hubspot/contacts')
      ]);
      if (accRes.ok) setAccountInfo(await accRes.json());
      if (contactsRes.ok) setAllContacts(await contactsRes.json());
      setConnectionStatus('ok');
    } catch (e) {
      setConnectionStatus('error');
    }
  };

  const refreshInvitations = async () => {
    setLoadingContacts(true);
    try {
      const res = await fetch('/api/invitations/all');
      if (res.ok) {
        const data = await res.json();
        setInvitations(Array.isArray(data) ? data : []);
      }
    } catch (e) {
      console.error(e);
    } finally {
      setLoadingContacts(false);
    }
  };

  const searchHubSpot = async () => {
    if (!topic) return;
    setLoading(true);
    setStatus(null);
    try {
      let keywords = [topic];
      if (isSmartSearch && settings.geminiApiKey) {
        try {
          const ai = getAi(settings.geminiApiKey);
          const result = await ai.models.generateContent({
            model: "gemini-3-flash-preview",
            contents: [{ 
              role: "user", 
              parts: [{ text: `Expand the topic "${topic}" into 30 professional search keywords in Arabic and English. 
              CRITICAL: Include all linguistic variations:
              - Masculine and Feminine forms (e.g., 'تقني' and 'تقنية')
              - Singular and Plural (e.g., 'مهندس' and 'مهندسين')
              - With and without 'Al' prefix (e.g., 'برمجة' and 'البرمجة')
              - Common synonyms and related fields.
              Return ONLY a JSON array of strings.` }]
            }],
            config: {
              responseMimeType: "application/json",
            }
          });
          const text = result.text.trim();
          const aiKeywords = JSON.parse(text);
          keywords = [...new Set([topic, ...aiKeywords])];
        } catch (e) {
          console.warn("AI keyword expansion failed:", e);
        }
      }

      const res = await fetch('/api/hubspot/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ topic, keywords }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.details || data.error);
      setContacts(data);
    } catch (err: any) {
      setStatus({ type: 'error', message: err.message });
    } finally {
      setLoading(false);
    }
  };

  const sendInvitations = async (targetContacts: Contact[] = contacts) => {
    if (targetContacts.length === 0) return;
    if (!sessionDetails.title) {
      setStatus({ type: 'error', message: 'يرجى إدخال عنوان للجلسة أولاً.' });
      return;
    }

    setSending(true);
    try {
      const res = await fetch('/api/invitations/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contacts: targetContacts, sessionDetails }),
      });
      if (res.ok) {
        setStatus({ type: 'success', message: `تم إرسال ${targetContacts.length} دعوة بنجاح!` });
        if (targetContacts === contacts) setContacts([]);
        setSelectedIds(new Set());
        refreshInvitations();
      } else {
        throw new Error('فشل الإرسال');
      }
    } catch (err: any) {
      setStatus({ type: 'error', message: err.message });
    } finally {
      setSending(false);
    }
  };

  const sendSelectedInvitations = () => {
    const selected = (showOverview ? allContacts : contacts).filter(c => selectedIds.has(c.id));
    sendInvitations(selected);
  };

  const toggleSelect = (id: string) => {
    const next = new Set(selectedIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelectedIds(next);
  };

  const toggleSelectAll = (currentList: Contact[]) => {
    const next = new Set(selectedIds);
    const allIn = currentList.every(c => next.has(c.id));
    currentList.forEach(c => allIn ? next.delete(c.id) : next.add(c.id));
    setSelectedIds(next);
  };

  const removeContact = (id: string) => {
    setContacts(prev => prev.filter(c => c.id !== id));
    const next = new Set(selectedIds);
    next.delete(id);
    setSelectedIds(next);
  };

  const filteredContacts = useMemo(() => {
    return contacts.filter(c => {
      const matchesRole = roleFilter === 'all' || c.properties.role === roleFilter;
      const matchesSearch = !resultsSearch || 
        Object.values(c.properties).some(v => String(v).toLowerCase().includes(resultsSearch.toLowerCase()));
      return matchesRole && matchesSearch;
    });
  }, [contacts, roleFilter, resultsSearch]);

  const uniqueRoles = useMemo(() => Array.from(new Set(contacts.map(c => c.properties.role).filter(Boolean))), [contacts]);

  const filteredOverviewContacts = useMemo(() => {
    return allContacts.filter(c => {
      const matchesRole = overviewRoleFilter === 'all' || c.properties.role === overviewRoleFilter;
      const matchesSearch = !overviewSearch || 
        Object.values(c.properties).some(v => String(v).toLowerCase().includes(overviewSearch.toLowerCase()));
      return matchesRole && matchesSearch;
    });
  }, [allContacts, overviewRoleFilter, overviewSearch]);

  const uniqueOverviewRoles = useMemo(() => Array.from(new Set(allContacts.map(c => c.properties.role).filter(Boolean))), [allContacts]);

  const generateAiReply = async () => {
    if (!inquiry || !settings.geminiApiKey) return;
    setAiLoading(true);
    const ai = getAi(settings.geminiApiKey);
    try {
      const result = await ai.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: `You are an assistant for Doroob Community. Help reply to this message in professional Arabic: "${inquiry}". Guidelines: ${DOROOB_SERVICES}`
      });
      setAiReply(result.text);
    } catch (e: any) {
      setStatus({ type: 'error', message: 'فشل توليد الرد الذكي' });
    } finally {
      setAiLoading(false);
    }
  };

  const sendAiReplyEmail = async () => {
    if (!aiReply || !recipientEmail) return;
    setMailSending(true);
    try {
      const res = await fetch('/api/mail/send-custom', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to: recipientEmail, subject: 'رد على استفساركم - مجتمع دروب', body: aiReply }),
      });
      if (res.ok) {
        setStatus({ type: 'success', message: 'تم إرسال الرد بنجاح' });
        setAiReply('');
        setInquiry('');
      } else {
        throw new Error('فشل الإرسال');
      }
    } catch (e) {
      setStatus({ type: 'error', message: 'فشل إرسال البريد' });
    } finally {
      setMailSending(false);
    }
  };

  const handleLinkChange = (link: string) => {
    setSessionDetails({ ...sessionDetails, locationLink: link });
  };

  const updateAttendance = async (id: string, attendance: 'attended' | 'absent' | null) => {
    try {
      const res = await fetch('/api/invitations/attendance', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, attendance })
      });
      if (res.ok) {
        setInvitations(prev => prev.map(inv => inv.id === id ? { ...inv, attendance } : inv));
        setStatus({ type: 'success', message: 'تم تحديث حالة الحضور' });
      }
    } catch (e) {
      setStatus({ type: 'error', message: 'فشل تحديث حالة الحضور' });
    }
  };

  const archiveSession = async (notes: string) => {
    if (invitations.length === 0) return;
    setArchiving(true);
    try {
      const res = await fetch('/api/archives/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notes })
      });
      if (res.ok) {
        setStatus({ type: 'success', message: 'تم أرشفة الجلسة بنجاح وتصفير اللوحة' });
        setInvitations([]);
        setShowArchiveNotesModal(false);
        setArchiveNotes('');
        fetchArchives(); // Refresh the archives list
      } else {
        const err = await res.json();
        setStatus({ type: 'error', message: err.error || 'فشل أرشفة الجلسة' });
      }
    } catch (e) {
      setStatus({ type: 'error', message: 'تعذر الاتصال بالسيرفر للأرشفة' });
    } finally {
      setArchiving(false);
    }
  };

  const deleteInvitation = async (id: string) => {
    console.log('Force deleting invitation:', id);
    const originalInvitations = [...invitations];
    
    // Optimistic update - update UI immediately
    setInvitations(prev => prev.filter(inv => inv.id !== id));
    
    try {
      const res = await fetch(`/api/invitations/${encodeURIComponent(id)}`, { 
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json'
        }
      });
      
      if (res.ok) {
        console.log('Successfully deleted from server:', id);
        setStatus({ type: 'success', message: 'تم حذف الدعوة بنجاح من النظام' });
      } else {
        const errData = await res.json().catch(() => ({}));
        console.error('Server failed to delete:', errData);
        // Revert UI on failure
        setInvitations(originalInvitations);
        setStatus({ type: 'error', message: errData.error || 'فشل حذف الدعوة من السيرفر' });
      }
    } catch (e: any) {
      console.error('Network or unexpected error while deleting:', e);
      // Revert UI on error
      setInvitations(originalInvitations);
      setStatus({ type: 'error', message: 'تعذر الاتصال بالسيرفر لحذف الدعوة' });
    }
  };

  const counts = useMemo(() => ({
    yes: invitations.filter(inv => inv.status === 'yes' && inv.mode !== 'walk-in_guest').length,
    no: invitations.filter(inv => inv.status === 'no').length,
    pending: invitations.filter(inv => (inv.status === 'pending' || !inv.status || inv.status === 'sent') && inv.mode !== 'walk-in_guest').length,
    attended: invitations.filter(inv => inv.attendance === 'attended').length,
    guests: invitations.filter(inv => inv.mode === 'walk-in_guest').length,
    total: invitations.length
  }), [invitations]);

  const filteredInvitations = useMemo(() => {
    switch (invitationFilter) {
      case 'pending': return invitations.filter(inv => (inv.status === 'pending' || !inv.status || inv.status === 'sent') && inv.mode !== 'walk-in_guest');
      case 'yes': return invitations.filter(inv => inv.status === 'yes' && inv.mode !== 'walk-in_guest');
      case 'no': return invitations.filter(inv => inv.status === 'no');
      case 'attended': return invitations.filter(inv => inv.attendance === 'attended');
      case 'guest': return invitations.filter(inv => inv.mode === 'walk-in_guest');
      default: return invitations;
    }
  }, [invitations, invitationFilter]);

  const copyToClipboard = (text: string, msg: string) => {
    navigator.clipboard.writeText(text).then(() => {
      setStatus({ type: 'success', message: msg });
    });
  };

  return (
    <div className="h-screen flex bg-slate-50 text-slate-900 font-sans selection:bg-orange-100 antialiased" dir="rtl">
      {/* Sidebar */}
      <AnimatePresence mode="wait">
        {sidebarOpen && (
          <motion.aside
            initial={{ width: 0, opacity: 0 }}
            animate={{ width: 280, opacity: 1 }}
            exit={{ width: 0, opacity: 0 }}
            className="fixed md:relative h-full bg-white border-l border-slate-200 z-50 flex flex-col shadow-xl md:shadow-none overflow-hidden shrink-0"
          >
            <div className="p-8 border-b border-slate-100 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 bg-orange-600 rounded-xl flex items-center justify-center text-white shadow-lg shadow-orange-100">
                  <Users size={22} />
                </div>
                <h1 className="text-xl font-bold text-slate-800">مجتمع دروب</h1>
              </div>
              <button onClick={() => setSidebarOpen(false)} className="md:hidden text-slate-400 hover:text-slate-600">
                <ChevronDown className="rotate-90" />
              </button>
            </div>

            <nav className="flex-1 p-4 space-y-1.5 overflow-y-auto">
              <NavButton 
                active={activeTab === 'dashboard'} 
                onClick={() => { setActiveTab('dashboard'); setSidebarOpen(false); }} 
                icon={<LayoutDashboard size={18} />} 
                label="لوحة التحكم" 
              />
              <NavButton 
                active={activeTab === 'invitations'} 
                onClick={() => { setActiveTab('invitations'); setSidebarOpen(false); }} 
                icon={<Mail size={18} />} 
                label="الدعوات المرسلة" 
              />
              <NavButton 
                active={activeTab === 'archives'} 
                onClick={() => { setActiveTab('archives'); setSidebarOpen(false); }} 
                icon={<RotateCcw size={18} />} 
                label="أرشيف الجلسات" 
              />
              <div className="pt-6 pb-2 px-4 text-[10px] uppercase font-bold text-slate-400">النظام</div>
              <NavButton 
                active={activeTab === 'settings'} 
                onClick={() => { setActiveTab('settings'); setSidebarOpen(false); }} 
                icon={<Settings size={18} />} 
                label="الإعدادات" 
              />
            </nav>

            <div className="p-4 border-t border-slate-100">
              <button className="w-full flex items-center gap-3 px-4 py-3 rounded-xl text-slate-400 hover:text-red-600 hover:bg-red-50 transition-all text-sm group">
                <LogOut size={16} className="group-hover:translate-x-1 transition-transform" />
                <span>تسجيل خروج</span>
              </button>
            </div>
          </motion.aside>
        )}
      </AnimatePresence>

      {/* Main Content */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        <header className="h-20 bg-white/80 backdrop-blur-xl border-b border-slate-200 shrink-0 z-40 flex items-center px-4 sm:px-8 justify-between">
          <div className="flex items-center gap-4">
            <button 
              onClick={() => setSidebarOpen(!sidebarOpen)}
              className="p-2 bg-slate-50 border border-slate-200 rounded-xl text-slate-500 hover:text-orange-600 hover:border-orange-200 transition-all shadow-sm"
            >
              <Users size={20} />
            </button>
            <h2 className="text-xl font-bold text-slate-800 truncate">
              {activeTab === 'dashboard' ? 'التخطيط والبحث' : activeTab === 'invitations' ? 'متابعة الحضور' : activeTab === 'archives' ? 'أرشيف الجلسات' : 'إعدادات النظام'}
            </h2>
          </div>
          <div className="flex items-center gap-3">
             <button 
                onClick={() => setShowOverview(!showOverview)}
                className={`flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-bold border transition-all ${showOverview ? 'bg-orange-50 text-orange-600 border-orange-200' : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'}`}
              >
                <Globe size={16} />
                <span className="hidden sm:inline">نظرة عامة على HubSpot</span>
              </button>
          </div>
        </header>

        <main className="flex-1 overflow-y-auto custom-scrollbar p-4 sm:p-8">
          <div className="max-w-7xl mx-auto space-y-8">
            {activeTab === 'dashboard' && (
              <>
                {/* HubSpot Stats Overview Overlay */}
                <AnimatePresence>
                  {showOverview && (
                    <motion.div 
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: 'auto', opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      className="overflow-hidden"
                    >
                      <HubSpotOverview 
                        accountInfo={accountInfo}
                        contacts={filteredOverviewContacts}
                        totalContacts={allContacts.length}
                        onSearchChange={setOverviewSearch}
                        onRoleChange={setOverviewRoleFilter}
                        uniqueRoles={uniqueOverviewRoles}
                        selectedIds={selectedIds}
                        onToggleSelect={toggleSelect}
                        onToggleSelectAll={() => toggleSelectAll(filteredOverviewContacts)}
                        onSendSelected={sendSelectedInvitations}
                        sending={sending}
                        hasSessionTitle={!!sessionDetails.title}
                      />
                    </motion.div>
                  )}
                </AnimatePresence>

                {/* Main Steps Grid */}
                <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                  {/* Step 1: Session Details */}
                  <div className="bg-white p-6 rounded-3xl border border-slate-200 shadow-sm space-y-6">
                    <div className="flex items-center gap-3 pb-2">
                       <div className="w-10 h-10 bg-purple-50 text-purple-600 rounded-xl flex items-center justify-center">
                         <Calendar size={20} />
                       </div>
                       <h3 className="font-bold text-lg">تفاصيل الجلسة</h3>
                    </div>
                    <div className="space-y-4">
                      <InputField label="عنوان الجلسة" value={sessionDetails.title} onChange={v => setSessionDetails({...sessionDetails, title: v})} placeholder="مثال: ورشة عمل هندسية" required />
                      <div className="grid grid-cols-2 gap-4">
                        <InputField label="التاريخ" type="date" value={sessionDetails.date} onChange={v => setSessionDetails({...sessionDetails, date: v})} />
                        <InputField label="الوقت" value={sessionDetails.time} onChange={v => setSessionDetails({...sessionDetails, time: v})} placeholder="7:00 م" />
                      </div>
                      <InputField label="اسم الموقع" value={sessionDetails.locationName} onChange={v => setSessionDetails({...sessionDetails, locationName: v})} icon={<MapPin size={16} />} placeholder="ديوانية دروب" />
                      <InputField label="رابط Google Maps" value={sessionDetails.locationLink} onChange={handleLinkChange} icon={<Navigation size={16} />} placeholder="الصق الرابط هنا" />
                    </div>
                  </div>

                  {/* Step 2: AI Search */}
                  <div className="bg-white p-6 rounded-3xl border border-slate-200 shadow-sm space-y-6">
                    <div className="flex items-center justify-between pb-2">
                       <div className="flex items-center gap-3">
                         <div className="w-10 h-10 bg-blue-50 text-blue-600 rounded-xl flex items-center justify-center">
                           <Search size={20} />
                         </div>
                         <h3 className="font-bold text-lg">البحث الذكي</h3>
                       </div>
                       <button 
                        onClick={() => setIsSmartSearch(!isSmartSearch)}
                        className={`text-[10px] px-3 py-1.5 rounded-full font-bold transition-all shadow-sm ${isSmartSearch ? 'bg-orange-600 text-white' : 'bg-slate-100 text-slate-400'}`}
                       >
                        {isSmartSearch ? "مفعل" : "معطل"}
                       </button>
                    </div>
                    <p className="text-sm text-slate-500 leading-relaxed">ابحث في HubSpot عن أشخاص تتناسب اهتماماتهم مع موضوع الجلسة.</p>
                    <div className="space-y-4 pt-4">
                      <div className="relative group">
                        <input 
                          type="text" 
                          value={topic}
                          onChange={(e) => setTopic(e.target.value)}
                          onKeyDown={(e) => e.key === 'Enter' && searchHubSpot()}
                          placeholder="كلمة مفتاحية أو تخصص..."
                          className="w-full bg-slate-50 border border-slate-200 rounded-2xl py-4 pr-4 pl-14 focus:ring-4 focus:ring-orange-500/10 focus:border-orange-200 outline-none transition-all font-medium"
                        />
                        <div className="absolute left-2 top-1/2 -translate-y-1/2 p-2 bg-white border border-slate-100 rounded-xl shadow-sm text-slate-400 group-focus-within:text-orange-600 transition-colors">
                          <Search size={20} />
                        </div>
                      </div>
                      
                      <button 
                        onClick={searchHubSpot}
                        disabled={loading || !topic}
                        className="w-full bg-orange-600 text-white py-4 rounded-2xl flex items-center justify-center gap-2 font-bold hover:shadow-lg shadow-orange-100 transition-all disabled:opacity-50 active:scale-[0.98]"
                      >
                        {loading ? <Loader2 className="animate-spin" size={20} /> : <Sparkles size={20} />}
                        بدء البحث الذكي
                      </button>
                    </div>
                  </div>

                  {/* Step 3: Execution */}
                  <div className="bg-white p-6 rounded-3xl border border-slate-200 shadow-sm flex flex-col justify-between">
                    <div>
                      <div className="w-10 h-10 bg-green-50 text-green-600 rounded-xl flex items-center justify-center mb-6">
                        <Send size={20} />
                      </div>
                      <h3 className="font-bold text-lg mb-2">إرسال الدعوات</h3>
                      <p className="text-sm text-slate-500 mb-6 leading-relaxed">سيتم إرسال بريد إلكتروني رسمي يحتوي على تفاصيل الجلسة ورابط التأكيد لجميع المختارين.</p>
                      
                      <div className="bg-slate-50 rounded-2xl p-6 text-center border border-slate-100">
                         <div className="text-4xl font-black text-orange-600 mb-1">{contacts.length}</div>
                         <div className="text-xs font-bold text-slate-400">شخص مستهدف حالياً</div>
                      </div>
                    </div>
                    
                    <div className="mt-6">
                      <button 
                        onClick={() => sendInvitations()}
                        disabled={sending || contacts.length === 0}
                        className="w-full bg-slate-900 text-white py-4 rounded-2xl flex items-center justify-center gap-2 font-black text-lg hover:bg-black transition-all shadow-xl disabled:opacity-50"
                      >
                        {sending ? <Loader2 className="animate-spin" /> : <Mail size={24} />}
                        إرسال لجميع العملاء
                      </button>
                    </div>
                  </div>
                </div>

                {/* Target Contacts List */}
                <div className="bg-white rounded-[2rem] border border-slate-200 shadow-sm overflow-hidden">
                  <div className="px-8 py-6 border-b border-slate-100 flex items-center justify-between bg-slate-50/30">
                    <h3 className="font-bold flex items-center gap-2">
                       <Users size={18} className="text-orange-600" />
                       قائمة المستهدفين من HubSpot
                    </h3>
                    <div className="flex items-center gap-4">
                       <button onClick={() => copyToClipboard(contacts.map(c => `${c.properties.firstname} ${c.properties.lastname} (${c.properties.email})`).join('\n'), 'تم نسخ قائمة الأسماء والإيميلات')} className="text-xs font-bold text-orange-600 hover:underline">نسخ الأسماء والإيميلات</button>
                       <span className="text-[10px] font-bold text-slate-300">تحديث مباشر</span>
                    </div>
                  </div>
                  
                  <div className="p-8">
                    {contacts.length > 0 ? (
                      <>
                        <div className="flex flex-col lg:flex-row justify-between gap-4 mb-6">
                          <div className="flex flex-wrap items-center gap-3">
                            <div className="relative flex-1 sm:flex-none">
                              <Search size={14} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400" />
                              <input 
                                type="text" 
                                value={resultsSearch} 
                                onChange={e => setResultsSearch(e.target.value)} 
                                placeholder="بحث في النتائج..." 
                                className="w-full sm:w-64 bg-slate-50 border border-slate-200 rounded-xl pr-9 pl-4 py-2.5 text-sm outline-none focus:ring-4 focus:ring-orange-500/10 transition-all"
                              />
                            </div>
                            <select 
                              value={roleFilter} 
                              onChange={e => setRoleFilter(e.target.value)}
                              className="bg-slate-50 border border-slate-200 rounded-xl px-4 py-2.5 text-sm outline-none min-w-[140px]"
                            >
                              <option value="all">جميع المناصب</option>
                              {uniqueRoles.map(r => <option key={r} value={r as string}>{r as string}</option>)}
                            </select>
                            
                            {selectedIds.size > 0 && (
                              <button 
                                onClick={sendSelectedInvitations}
                                disabled={sending}
                                className="bg-orange-600 text-white px-5 py-2.5 rounded-xl text-sm font-bold flex items-center gap-2 shadow-lg shadow-orange-100 disabled:opacity-50"
                              >
                                <Send size={14} />
                                إرسال لـ ({selectedIds.size}) مختارين
                              </button>
                            )}
                          </div>
                          <div className="text-xs text-slate-400 font-medium self-center">عرض {filteredContacts.length} جهة اتصال</div>
                        </div>

                         <div className="overflow-x-auto border border-slate-100 rounded-2xl">
                          <table className="w-full text-right text-sm">
                            <thead className="bg-slate-50 text-[10px] font-bold text-slate-500 border-b border-slate-100">
                              <tr>
                                <th className="px-3 py-2 w-12"><input type="checkbox" checked={filteredContacts.length > 0 && filteredContacts.every(c => selectedIds.has(c.id))} onChange={() => toggleSelectAll(filteredContacts)} className="w-4 h-4 rounded border-slate-300 text-orange-600 focus:ring-orange-500" /></th>
                                <th className="px-3 py-2 text-xs">الاسم والشركة</th>
                                <th className="px-3 py-2 text-xs">بيانات التواصل</th>
                                <th className="px-3 py-2 text-xs">المنصب والملخص</th>
                                <th className="px-3 py-2 text-xs text-center">إجراء</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-50">
                              {filteredContacts.map(c => (
                                <tr key={c.id} className={`hover:bg-slate-50 group transition-colors ${selectedIds.has(c.id) ? 'bg-orange-50/30' : ''}`}>
                                  <td className="px-3 py-1.5"><input type="checkbox" checked={selectedIds.has(c.id)} onChange={() => toggleSelect(c.id)} className="w-4 h-4 rounded border-slate-300 text-orange-600 focus:ring-orange-500" /></td>
                                  <td className="px-3 py-1.5">
                                    <div className="font-bold text-slate-800 text-sm leading-tight">{c.properties.firstname} {c.properties.lastname}</div>
                                    <div className="text-[10px] text-slate-500 font-medium">{c.properties.company || '—'}</div>
                                  </td>
                                  <td className="px-3 py-1.5">
                                    <div className="font-mono text-[10px] text-slate-500">{c.properties.email}</div>
                                    <div className="text-[10px] text-slate-400">{c.properties.phone || '—'}</div>
                                  </td>
                                  <td className="px-3 py-1.5 max-w-xl">
                                    <div className="flex flex-wrap gap-1.5 mb-1.5 items-center">
                                      <span className="text-[10px] font-bold text-slate-700 bg-slate-100 px-2 py-0.5 rounded-lg border border-slate-200 leading-normal">
                                        {c.properties.jobtitle || '—'}
                                      </span>
                                      {c.properties.role && (
                                        <span className="text-[9px] px-2 py-0.5 bg-orange-600 text-white rounded-md font-black shadow-sm ring-4 ring-orange-50/50 whitespace-nowrap leading-none inline-flex items-center justify-center min-w-[50px]">
                                          {c.properties.role}
                                        </span>
                                      )}
                                    </div>
                                    <div className="text-[10px] text-slate-600 leading-tight whitespace-pre-wrap bg-slate-50/50 p-2 rounded-lg border border-slate-100/50">
                                      {c.properties.summary || 'لا يوجد ملخص'}
                                    </div>
                                  </td>
                                  <td className="px-3 py-1.5 text-center">
                                    <button onClick={() => removeContact(c.id)} className="text-slate-300 hover:text-red-500 transition-colors"><Trash2 size={16} /></button>
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </>
                    ) : (
                      <div className="py-20 text-center space-y-4">
                         <div className="w-16 h-16 bg-slate-50 rounded-3xl flex items-center justify-center mx-auto text-slate-200"><Users size={32} /></div>
                         <p className="text-slate-400">لا توجد جهات اتصال مختارة. ابدأ بالبحث في الخطوة 2.</p>
                      </div>
                    )}
                  </div>
                </div>

                {/* AI Assistant Row */}
                <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
                   <div className="lg:col-span-12">
                      <div className="bg-slate-900 rounded-[2.5rem] p-10 text-white relative overflow-hidden shadow-2xl">
                        <div className="relative z-10 flex flex-col md:flex-row gap-12">
                          <div className="flex-1 space-y-6">
                             <div className="flex items-center gap-3">
                               <div className="w-12 h-12 bg-white/10 rounded-2xl flex items-center justify-center backdrop-blur-md">
                                 <Sparkles className="text-orange-400" />
                               </div>
                               <span className="text-sm font-bold text-orange-400">Gemini AI Assistant</span>
                             </div>
                             <h3 className="text-3xl font-black leading-tight">الرد الذكي لخدمة العملاء</h3>
                             <p className="text-slate-400 text-lg leading-relaxed">توليد ردود احترافية فورية بناءً على ميثاق خدمات دروب للرد على استفسارات المجتمع.</p>
                             <div className="flex flex-wrap gap-2 pt-4">
                                {['كيفية الانضمام؟', 'مواعيد الفعاليات', 'التواصل معنا'].map(q => (
                                  <button key={q} onClick={() => setInquiry(q)} className="text-xs px-4 py-2 bg-white/5 border border-white/10 rounded-full hover:bg-white/10 transition-colors">{q}</button>
                                ))}
                             </div>
                          </div>
                          <div className="flex-1 flex flex-col gap-4">
                             <textarea 
                                value={inquiry} 
                                onChange={e => setInquiry(e.target.value)}
                                className="w-full bg-white/5 border border-white/10 rounded-[2rem] p-6 text-white outline-none focus:ring-4 focus:ring-orange-500/20 h-48 resize-none placeholder:text-white/20"
                                placeholder="انسخ استفسار العميل هنا..."
                             />
                             <button 
                                onClick={generateAiReply}
                                disabled={aiLoading || !inquiry || aiConnectionStatus === 'missing'}
                                className="w-full bg-orange-600 text-white py-4 rounded-2xl font-black text-lg shadow-xl shadow-orange-900/40 hover:bg-orange-700 transition-all disabled:opacity-50"
                             >
                                {aiLoading ? <Loader2 className="animate-spin" /> : 'توليد الرد الاحترافي'}
                             </button>
                          </div>
                        </div>
                        <div className="absolute top-0 right-0 w-96 h-96 bg-orange-600/10 rounded-full blur-[120px] -translate-y-1/2 translate-x-1/4"></div>
                      </div>
                   </div>
                </div>

                {/* AI Reply Display */}
                <AnimatePresence>
                  {aiReply && (
                    <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="bg-white rounded-[2rem] border border-slate-200 shadow-xl p-10 space-y-8">
                       <div className="flex items-center justify-between border-b border-slate-100 pb-6">
                          <h4 className="font-bold flex items-center gap-2"><div className="w-2 h-2 bg-green-500 rounded-full"></div>مسودة الرد المقترحة</h4>
                          <button onClick={() => copyToClipboard(aiReply, 'تم النسخ')} className="text-xs font-bold text-orange-600">نسخ النص</button>
                       </div>
                       <div className="bg-slate-50 p-8 rounded-3xl text-slate-700 leading-relaxed text-lg whitespace-pre-wrap">{aiReply}</div>
                       <div className="grid grid-cols-1 md:grid-cols-2 gap-6 items-end">
                          <div>
                            <label className="block text-xs font-bold text-slate-400 uppercase mb-2">إيميل المستلم</label>
                            <input value={recipientEmail} onChange={e => setRecipientEmail(e.target.value)} className="w-full bg-slate-50 border border-slate-200 rounded-xl py-3 px-4 outline-none" placeholder="name@example.com" />
                          </div>
                          <button onClick={sendAiReplyEmail} disabled={mailSending || !recipientEmail} className="bg-slate-900 text-white py-3.5 rounded-xl font-bold flex items-center justify-center gap-2 hover:bg-black transition-all">إرسال للعميل الآن</button>
                       </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </>
            )}

            {activeTab === 'invitations' && (
              <div className="space-y-8">
                <div className="flex items-center justify-between">
                   <div>
                      <h2 className="text-3xl font-black mb-2">متابعة الحضور والدعوات</h2>
                      <p className="text-slate-500">مراقبة التفاعل الحي مع الدعوات وإدارة الحضور الميداني.</p>
                   </div>
                   <div className="flex items-center gap-3">
                      <button 
                        onClick={() => setShowArchiveNotesModal(true)} 
                        disabled={invitations.length === 0 || archiving}
                        className="flex items-center gap-2 px-6 py-3 bg-red-600 text-white rounded-2xl font-black hover:bg-red-700 transition-all shadow-lg shadow-red-100 disabled:opacity-50 disabled:shadow-none"
                      >
                        {archiving ? <Loader2 className="animate-spin" size={18} /> : <CheckCircle2 size={18} />}
                        <span>إنهاء وأرشفة الجلسة</span>
                      </button>
                      <button onClick={refreshInvitations} className="p-3 bg-white border border-slate-200 rounded-2xl hover:bg-slate-50 transition-all shadow-sm">
                         <RotateCcw size={20} className={loadingContacts ? 'animate-spin' : ''} />
                      </button>
                   </div>
                </div>

                <div className="grid grid-cols-2 lg:grid-cols-6 gap-4">
                  <StatCard label="إجمالي المدعوين" value={counts.total} color="slate" active={invitationFilter === 'all'} onClick={() => setInvitationFilter('all')} />
                  <StatCard label="بانتظار الرد" value={counts.pending} color="orange" active={invitationFilter === 'pending'} onClick={() => setInvitationFilter('pending')} />
                  <StatCard label="تم التأكيد" value={counts.yes} color="green" active={invitationFilter === 'yes'} onClick={() => setInvitationFilter('yes')} />
                  <StatCard label="اعتذروا" value={counts.no} color="red" active={invitationFilter === 'no'} onClick={() => setInvitationFilter('no')} />
                  <StatCard label="الحضور الحالي" value={counts.attended} color="black" active={invitationFilter === 'attended'} onClick={() => setInvitationFilter('attended')} />
                  <StatCard label="ضيوف جدد" value={counts.guests} color="indigo" active={invitationFilter === 'guest'} onClick={() => setInvitationFilter('guest')} />
                </div>

                <div className="bg-white rounded-[2rem] border border-slate-200 shadow-sm overflow-hidden">
                  <div className="px-8 py-6 border-b border-slate-100 flex items-center justify-between">
                     <div className="flex items-center gap-3">
                        <Mail className="text-blue-500" size={20} />
                        <span className="font-bold">سجلات الردود المفصلة</span>
                     </div>
                     <button onClick={() => {
                       const link = window.location.origin + '/api/checkin/unified';
                       copyToClipboard(link, 'تم نسخ رابط التحضير');
                     }} className="text-sm font-bold text-orange-600 bg-orange-50 px-4 py-2 rounded-xl border border-orange-100">نسخ رابط التحضير (QR)</button>
                  </div>
                  
                  <div className="overflow-x-auto">
                    <table className="w-full text-right text-sm">
                      <thead className="bg-slate-50 text-[10px] font-bold text-slate-400 border-b border-slate-100">
                        <tr>
                          <th className="px-8 py-4">المدعو</th>
                          <th className="px-8 py-4">الجلسة</th>
                          <th className="px-8 py-4">الرد (RSVP)</th>
                          <th className="px-8 py-4">تحضير الحضور</th>
                          <th className="px-8 py-4">تفاعل النظام</th>
                          <th className="px-8 py-4 text-center">إجراء</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-50">
                        {filteredInvitations.slice().reverse().map(inv => (
                          <tr key={inv.id} className="hover:bg-slate-50 transition-colors">
                            <td className="px-8 py-4">
                              <div className="font-bold text-slate-800 flex items-center gap-2">
                                {inv.name}
                                {inv.mode === 'walk-in_guest' && <span className="bg-indigo-50 text-indigo-600 px-2 py-0.5 rounded text-[9px] font-black uppercase">ضيف</span>}
                              </div>
                              <div className="font-mono text-[10px] text-slate-400">{inv.email}</div>
                            </td>
                            <td className="px-8 py-4 text-xs font-bold text-slate-600">{inv.sessionDetails?.title || 'غير محدد'}</td>
                            <td className="px-8 py-4">
                               <span className={`px-3 py-1 rounded-full text-[10px] font-bold ${
                                 inv.status === 'yes' ? 'bg-green-100 text-green-700' :
                                 inv.status === 'no' ? 'bg-red-100 text-red-700' : 'bg-orange-100 text-orange-700'
                               }`}>
                                 {inv.status === 'yes' ? 'تم القبول' : inv.status === 'no' ? 'تم الرفض' : 'بانتظار الرد'}
                               </span>
                            </td>
                            <td className="px-8 py-4">
                               <div className="flex gap-2">
                                  <button 
                                    onClick={() => updateAttendance(inv.id, inv.attendance === 'attended' ? null : 'attended')}
                                    className={`w-9 h-9 rounded-xl flex items-center justify-center transition-all ${inv.attendance === 'attended' ? 'bg-green-600 text-white shadow-lg' : 'bg-slate-100 text-slate-400 hover:bg-green-100 hover:text-green-600'}`}
                                  >
                                    <CheckCircle2 size={16} />
                                  </button>
                                  <button 
                                    onClick={() => updateAttendance(inv.id, inv.attendance === 'absent' ? null : 'absent')}
                                    className={`w-9 h-9 rounded-xl flex items-center justify-center transition-all ${inv.attendance === 'absent' ? 'bg-red-600 text-white shadow-lg' : 'bg-slate-100 text-slate-400 hover:bg-red-100 hover:text-red-600'}`}
                                  >
                                    <AlertCircle size={16} />
                                  </button>
                               </div>
                               {inv.checkedInAt && <div className="text-[9px] font-bold text-green-600 mt-1 flex items-center gap-1"><div className="w-1 h-1 bg-green-500 rounded-full animate-pulse"></div>تحضير ذاتي</div>}
                            </td>
                            <td className="px-8 py-4">
                               <div className="flex flex-col gap-1 items-start">
                                  <div className="text-[9px] font-bold text-slate-400">{new Date(inv.sentAt).toLocaleString('ar-EG', { day: 'numeric', month: 'short' })}</div>
                                  {inv.clickedAt && <span className="text-[9px] font-bold text-blue-500 flex items-center gap-1"><CheckCircle2 size={10} /> تم النقر</span>}
                               </div>
                            </td>
                            <td className="px-8 py-4 text-center">
                              <button 
                                onClick={(e) => {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  setDeletingId(inv.id);
                                }}
                                className="group relative z-10 flex items-center justify-center w-10 h-10 mx-auto rounded-xl bg-white border-2 border-red-200 text-red-500 hover:bg-red-600 hover:text-white hover:border-red-600 transition-all duration-300 shadow-sm cursor-pointer"
                                title="حذف"
                              >
                                <Trash2 size={18} className="group-hover:scale-110 transition-transform" />
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            )}

            {activeTab === 'archives' && (
              <div className="space-y-8">
                <div>
                   <h2 className="text-3xl font-black mb-2">أرشيف الجلسات المنتهية</h2>
                   <p className="text-slate-500">تقارير إحصائية كاملة عن الجلسات السابقة لتحليل الأداء وتتبع النمو.</p>
                </div>

                {archives.length === 0 ? (
                  <div className="bg-white rounded-[2rem] p-20 text-center border-2 border-dashed border-slate-100">
                    <div className="w-20 h-20 bg-slate-50 rounded-3xl flex items-center justify-center mx-auto mb-6 text-slate-300">
                      <RotateCcw size={40} />
                    </div>
                    <h3 className="text-xl font-bold text-slate-900 mb-2">لا يوجد جلسات مؤرشفة</h3>
                    <p className="text-slate-400">بمجرد إنهاء جلستك الأولى من لوحة الـ "Invitations"، ستظهر هنا التقارير.</p>
                  </div>
                ) : (
                  <div className="grid grid-cols-1 gap-6">
                    {archives.map(archive => (
                      <motion.div 
                        key={archive.id}
                        initial={{ opacity: 0, y: 20 }}
                        animate={{ opacity: 1, y: 0 }}
                        className="bg-white rounded-[2.5rem] border border-slate-200 p-8 shadow-sm hover:shadow-md transition-all group relative overflow-hidden"
                      >
                        <div className="absolute top-0 right-0 w-32 h-32 bg-slate-50 rounded-bl-[5rem] -mr-10 -mt-10 group-hover:bg-orange-50 transition-colors" />
                        
                        <div className="relative flex flex-col lg:flex-row lg:items-center justify-between gap-8">
                          <div className="space-y-3 flex-1">
                            <div className="flex items-center gap-3">
                              <span className="px-3 py-1 bg-slate-900 text-white text-[10px] font-black rounded-lg uppercase tracking-wider">تقرير جلسة</span>
                              <span className="text-xs font-bold text-slate-400 flex items-center gap-1">
                                <Calendar size={14} />
                                {archive.sessionDate}
                              </span>
                            </div>
                            <h3 className="text-2xl font-black text-slate-900">{archive.title}</h3>
                            <div className="flex items-center gap-2 text-sm text-slate-500">
                              <Clock size={14} />
                              تمت الأرشفة في {new Date(archive.archivedAt).toLocaleDateString()} - {new Date(archive.archivedAt).toLocaleTimeString()}
                            </div>
                          </div>

                          <div className="grid grid-cols-2 sm:grid-cols-6 gap-4 px-6 py-4 bg-slate-50 rounded-3xl border border-slate-100 flex-shrink-0">
                            <div className="text-center">
                              <div className="text-lg font-black text-slate-900">{archive.attendedCount}</div>
                              <div className="text-[9px] font-bold text-slate-400 uppercase">حضروا</div>
                            </div>
                            <div className="text-center">
                              <div className="text-lg font-black text-blue-600">{archive.newGuests?.length || 0}</div>
                              <div className="text-[9px] font-bold text-slate-400 uppercase">ضيوف جدد</div>
                            </div>
                            <div className="text-center">
                              <div className="text-lg font-black text-green-600">{archive.confirmedAttending}</div>
                              <div className="text-[9px] font-bold text-slate-400 uppercase">أكدوا</div>
                            </div>
                            <div className="text-center">
                              <div className="text-lg font-black text-red-500">{archive.apologizedCount}</div>
                              <div className="text-[9px] font-bold text-slate-400 uppercase">اعتذروا</div>
                            </div>
                            <div className="text-center">
                              <div className="text-lg font-black text-orange-600">{archive.confirmedButAbsent}</div>
                              <div className="text-[9px] font-bold text-slate-400 uppercase">غابوا</div>
                            </div>
                            <div className="text-center">
                              <div className="text-lg font-black text-slate-400">{archive.noResponseCount || 0}</div>
                              <div className="text-[9px] font-bold text-slate-400 uppercase">لم يردوا</div>
                            </div>
                          </div>

                          <div className="flex items-center gap-2">
                             <button 
                               onClick={() => sendThanksToAttendees(archive.id)}
                               disabled={sendingThanksId === archive.id || !archive.attendees || archive.attendees.length === 0}
                               className="p-4 bg-orange-600 text-white rounded-2xl hover:bg-orange-700 transition-all shadow-lg shadow-orange-100 disabled:opacity-50"
                               title="إرسال رسائل الشكر والتقييم للحاضرين"
                             >
                                {sendingThanksId === archive.id ? <Loader2 className="animate-spin" size={20} /> : <Send size={20} />}
                             </button>
                             <button 
                               onClick={() => {
                                 const headers = ['ID', 'Attended', 'Confirmed', 'Absent', 'Apologized', 'No Response'];
                                 const rows = [
                                   [archive.id, archive.attendedCount, archive.confirmedAttending, archive.confirmedButAbsent, archive.apologizedCount, archive.noResponseCount]
                                 ];
                                 const csvContent = "data:text/csv;charset=utf-8," + 
                                   [headers.join(','), ...rows.map(e => e.join(','))].join('\n');
                                 const encodedUri = encodeURI(csvContent);
                                 const link = document.createElement("a");
                                 link.setAttribute("href", encodedUri);
                                 link.setAttribute("download", `archive_${archive.id}.csv`);
                                 document.body.appendChild(link);
                                 link.click();
                                 document.body.removeChild(link);
                                }}
                               className="p-4 bg-slate-50 text-slate-500 rounded-2xl hover:bg-slate-900 hover:text-white transition-all shadow-sm"
                               title="تصدير CSV"
                             >
                                <Download size={20} />
                             </button>
                             <button 
                               onClick={() => setDeletingArchiveId(archive.id)}
                               className="p-4 bg-red-50 text-red-500 rounded-2xl hover:bg-red-600 hover:text-white transition-all shadow-sm shadow-red-50"
                             >
                               <Trash2 size={20} />
                             </button>
                          </div>
                        </div>

                        {archive.notes && (
                          <div className="mt-8 pt-8 border-t border-slate-100">
                            <div className="flex items-start gap-4">
                              <div className="w-10 h-10 bg-orange-50 text-orange-600 rounded-xl flex items-center justify-center shrink-0">
                                <MessageSquare size={18} />
                              </div>
                              <div className="space-y-1">
                                <h4 className="text-xs font-bold text-slate-400 uppercase">ملاحظات ختامية</h4>
                                <p className="text-slate-600 leading-relaxed italic">"{archive.notes}"</p>
                              </div>
                            </div>
                          </div>
                        )}
                      </motion.div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {activeTab === 'settings' && (
              <div className="max-w-2xl space-y-8">
                 <div>
                    <h2 className="text-3xl font-black mb-2">إعدادات النظام والربط</h2>
                    <p className="text-slate-500">تكوين حسابات الإرسال ومفاتيح الربط البرمجية لضمان عمل الأتمتة.</p>
                 </div>

                 <div className="space-y-6">
                    <SettingsSection title="إعدادات Gmail" icon={<Mail className="text-orange-600" />}>
                       <div className="space-y-4">
                          <InputField label="عنوان Gmail" value={settings.gmailUser} onChange={v => setSettings({...settings, gmailUser: v})} placeholder="user@gmail.com" />
                          <InputField label="كلمة مرور التطبيقات (App Password)" type={showGmailPass ? 'text' : 'password'} value={settings.gmailPass} onChange={v => setSettings({...settings, gmailPass: v})} placeholder="•••• •••• •••• ••••" action={<button onClick={() => setShowGmailPass(!showGmailPass)}>{showGmailPass ? <EyeOff size={18} /> : <Eye size={18} />}</button>} />
                          <p className="text-[10px] text-slate-400 bg-slate-50 p-4 rounded-xl border border-slate-100 italic leading-relaxed">
                             مهم: يجب استخدام "كلمة مرور تطبيق" من حساب جوجل، وليس كلمة المرور الأساسية. تأكد من تفعيل التحقق بخطوتين أولاً.
                          </p>
                       </div>
                    </SettingsSection>

                    <SettingsSection title="الربط البرمجي (APIs)" icon={<Globe className="text-blue-600" />}>
                       <div className="space-y-4">
                          <InputField label="HubSpot Private App Token" type={showHubspotToken ? 'text' : 'password'} value={settings.hubspotToken} onChange={v => setSettings({...settings, hubspotToken: v})} placeholder="pat-na1-..." action={<button onClick={() => setShowHubspotToken(!showHubspotToken)}>{showHubspotToken ? <EyeOff size={18} /> : <Eye size={18} />}</button>} />
                          <InputField label="رابط الموقع العام (Public URL)" value={settings.publicAppUrl} onChange={v => setSettings({...settings, publicAppUrl: v})} placeholder="https://your-app.run.app" />
                          <InputField label="Gemini AI Key" type="password" value={settings.geminiApiKey} onChange={v => setSettings({...settings, geminiApiKey: v})} placeholder="اضف مفتاح AI Studio..." />
                          <InputField label="رابط تقييم الجلسة (Survey)" type="text" value={settings.feedbackLink || ''} onChange={v => setSettings({...settings, feedbackLink: v})} placeholder="https://forms.gle/..." />
                       </div>
                    </SettingsSection>
                    
                    <button 
                      onClick={updateSettings} 
                      disabled={settingsLoading} 
                      className="w-full bg-black text-white py-5 rounded-[2rem] font-black text-lg flex items-center justify-center gap-3 hover:shadow-2xl transition-all shadow-slate-300 disabled:opacity-50"
                    >
                      {settingsLoading ? <Loader2 className="animate-spin" /> : <ShieldCheck size={24} />}
                      حفظ جميع الإعدادات وتأمين النظام
                    </button>
                    
                    <div className="mt-8 pt-8 border-t border-slate-200">
                      <SystemStatusPanel />
                    </div>
                 </div>
              </div>
            )}
          </div>
        </main>
      </div>

      {/* Custom Delete Confirmation Modal */}
      <AnimatePresence>
        {deletingId && (
          <DeleteConfirmModal 
            title="تأكيد حذف الدعوة"
            description="هذا الإجراء نهائي ولا يمكن التراجع عنه. هل أنت متأكد من رغبتك في مسح سجل هذه الدعوة تماماً؟"
            onConfirm={() => {
              if (deletingId) {
                deleteInvitation(deletingId);
                setDeletingId(null);
              }
            }}
            onCancel={() => setDeletingId(null)}
          />
        )}
        {deletingArchiveId && (
          <DeleteConfirmModal 
            title="تأكيد حذف الأرشيف"
            description="هل أنت متأكد من رغبتك في حذف هذا الأرشيف؟ سيتم مسح كافة البيانات والإحصائيات الخاصة بهذه الجلسة نهائياً من النظام."
            onConfirm={() => {
              if (deletingArchiveId) {
                deleteArchive(deletingArchiveId);
                setDeletingArchiveId(null);
              }
            }}
            onCancel={() => setDeletingArchiveId(null)}
          />
        )}
      </AnimatePresence>

      {/* Archive Confirmation & Notes Modal */}
      <AnimatePresence>
        {showArchiveNotesModal && (
          <div className="fixed inset-0 z-[300] flex items-center justify-center p-4">
            <motion.div 
              initial={{ opacity: 0 }} 
              animate={{ opacity: 1 }} 
              exit={{ opacity: 0 }} 
              onClick={() => setShowArchiveNotesModal(false)}
              className="absolute inset-0 bg-slate-900/60 backdrop-blur-sm"
            />
            <motion.div 
              initial={{ opacity: 0, scale: 0.9, y: 20 }} 
              animate={{ opacity: 1, scale: 1, y: 0 }} 
              exit={{ opacity: 0, scale: 0.9, y: 20 }} 
              className="relative bg-white w-full max-w-lg rounded-[2.5rem] shadow-2xl overflow-hidden"
            >
              <div className="p-10 space-y-8">
                <div className="text-center space-y-4">
                  <div className="w-20 h-20 bg-orange-50 text-orange-600 rounded-3xl flex items-center justify-center mx-auto shadow-inner">
                    <CheckCircle2 size={36} />
                  </div>
                  <div className="space-y-2">
                    <h3 className="text-2xl font-black text-slate-900">إنهاء الجلسة وأرشفتها</h3>
                    <p className="text-slate-500 leading-relaxed text-sm">سيتم حساب الإحصائيات النهائية، تصفير لوحة التحكم الحالية، وحفظ كافة البيانات في الأرشيف للرجوع إليها لاحقاً.</p>
                  </div>
                </div>

                <div className="space-y-2">
                  <label className="text-xs font-black text-slate-400 uppercase px-2 flex items-center gap-2">
                    <Sparkles size={14} className="text-orange-500" />
                    ملاحظات أو انطباعات عن الجلسة (اختياري)
                  </label>
                  <textarea 
                    value={archiveNotes}
                    onChange={e => setArchiveNotes(e.target.value)}
                    placeholder="اكتب هنا أي ملاحظات حول أداء الجلسة، تفاعل الحضور، أو أي دروس مستفادة..."
                    className="w-full bg-slate-50 border border-slate-100 rounded-3xl p-6 outline-none focus:border-orange-200 transition-all h-32 text-slate-600 resize-none"
                  />
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <button 
                    onClick={() => setShowArchiveNotesModal(false)}
                    className="py-4 rounded-2xl font-bold bg-slate-50 text-slate-600 hover:bg-slate-100 transition-all"
                  >
                    إلغاء وتراجع
                  </button>
                  <button 
                    onClick={() => archiveSession(archiveNotes)}
                    disabled={archiving}
                    className="py-4 rounded-2xl font-black bg-orange-600 text-white shadow-lg shadow-orange-100 hover:bg-orange-700 transition-all active:scale-[0.98] disabled:opacity-50 flex items-center justify-center gap-2"
                  >
                    {archiving ? <Loader2 className="animate-spin" size={20} /> : <Send size={20} />}
                    أرشفة الآن
                  </button>
                </div>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Global Status Toast */}
      <AnimatePresence>
        {status && (
          <motion.div 
            initial={{ opacity: 0, y: -100 }} 
            animate={{ opacity: 1, y: 0 }} 
            exit={{ opacity: 0, y: -100 }} 
            className="fixed top-8 left-1/2 -translate-x-1/2 z-[200] max-w-sm w-full px-4"
          >
            <div className={`p-5 rounded-3xl shadow-2xl flex items-center gap-4 border backdrop-blur-xl ${status.type === 'success' ? 'bg-green-600/95 border-green-400 text-white shadow-green-500/20' : 'bg-red-600/95 border-red-400 text-white shadow-red-500/20'}`}>
              {status.type === 'success' ? <CheckCircle2 size={24} /> : <AlertCircle size={24} />}
              <div className="flex-1 font-bold text-sm tracking-tight">{status.message}</div>
              <button 
                onClick={() => setStatus(null)} 
                className="w-8 h-8 flex items-center justify-center hover:bg-white/20 rounded-full transition-colors font-black text-xl"
              >
                ×
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function SystemStatusPanel() {
  const [status, setStatus] = useState<any>(null);
  const [loading, setLoading] = useState(false);

  const checkStatus = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/debug');
      const data = await res.json();
      setStatus(data);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="bg-slate-900 rounded-[2rem] p-8 text-white space-y-6 overflow-hidden relative">
      <div className="relative z-10 flex items-center justify-between">
        <div className="flex items-center gap-3">
           <div className="w-10 h-10 bg-white/10 rounded-xl flex items-center justify-center backdrop-blur-md">
             <ShieldCheck className="text-green-400" size={20} />
           </div>
           <h3 className="font-bold flex flex-col">
             تشخيص حالة النظام
             <span className="text-[10px] text-slate-400 font-normal">التأكد من قراءة مفاتيح Vercel</span>
           </h3>
        </div>
        <button 
          onClick={checkStatus} 
          disabled={loading}
          className="px-4 py-2 bg-white/10 hover:bg-white/20 rounded-xl text-xs font-bold transition-all flex items-center gap-2"
        >
          {loading ? <Loader2 size={14} className="animate-spin" /> : <RotateCcw size={14} />}
          فحص الاتصال
        </button>
      </div>

      {status ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 animate-fade-in relative z-10">
          <div className="bg-white/5 p-4 rounded-2xl border border-white/5">
             <span className="text-[10px] text-slate-500 block mb-2 font-bold uppercase">متغيرات Vercel</span>
             <div className="space-y-2">
                {Object.entries(status.variables || {}).map(([key, value]: any) => (
                  <div key={key} className="flex items-center justify-between text-xs">
                     <span className="font-mono text-slate-400">{key}</span>
                     {String(value).startsWith("Present") ? <CheckCircle2 size={14} className="text-green-400" /> : <AlertCircle size={14} className="text-red-400" />}
                  </div>
                ))}
             </div>
          </div>
          <div className="bg-white/5 p-4 rounded-2xl border border-white/5">
             <span className="text-[10px] text-slate-500 block mb-2 font-bold uppercase">قاعدة البيانات (Firebase)</span>
             <div className="text-sm font-bold text-slate-200">{status.firestore}</div>
             <div className="text-[10px] text-slate-300 mt-1">Project ID: <span className="font-mono text-orange-400">{status.configSource}</span></div>
             <p className="text-[10px] text-slate-500 mt-3 leading-relaxed">إذا كان NULL، فسيستخدم السيرفر مفاتيح Vercel المباشرة كبديل مستقر.</p>
          </div>
        </div>
      ) : (
        <div className="text-center py-4 relative z-10">
           <p className="text-slate-500 text-xs italic">اضغط على فحص الاتصال للتأكد من حالة المفاتيح...</p>
        </div>
      )}
      
      <div className="absolute top-0 right-0 w-64 h-64 bg-orange-600/5 rounded-full blur-[80px] -translate-y-1/2 translate-x-1/4"></div>
    </div>
  );
}

function DeleteConfirmModal({ onConfirm, onCancel, title, description }: { onConfirm: () => void, onCancel: () => void, title?: string, description?: string }) {
  return (
    <div className="fixed inset-0 z-[300] flex items-center justify-center p-4">
      <motion.div 
        initial={{ opacity: 0 }} 
        animate={{ opacity: 1 }} 
        exit={{ opacity: 0 }} 
        onClick={onCancel}
        className="absolute inset-0 bg-slate-900/60 backdrop-blur-sm"
      />
      <motion.div 
        initial={{ opacity: 0, scale: 0.9, y: 20 }} 
        animate={{ opacity: 1, scale: 1, y: 0 }} 
        exit={{ opacity: 0, scale: 0.9, y: 20 }} 
        className="relative bg-white w-full max-w-md rounded-[2.5rem] shadow-2xl overflow-hidden"
      >
        <div className="p-10 text-center space-y-6">
          <div className="w-20 h-20 bg-red-50 text-red-500 rounded-3xl flex items-center justify-center mx-auto mb-2">
            <Trash2 size={36} />
          </div>
          
          <div className="space-y-2">
            <h3 className="text-2xl font-black text-slate-900">{title || "تأكيد حذف الدعوة"}</h3>
            <p className="text-slate-500 leading-relaxed">{description || "هذا الإجراء نهائي ولا يمكن التراجع عنه. هل أنت متأكد من رغبتك في مسح سجل هذه الدعوة تماماً؟"}</p>
          </div>

          <div className="grid grid-cols-2 gap-4 pt-4">
            <button 
              onClick={onCancel}
              className="py-4 rounded-2xl font-bold bg-slate-50 text-slate-600 hover:bg-slate-100 transition-all"
            >
              إلغاء
            </button>
            <button 
              onClick={onConfirm}
              className="py-4 rounded-2xl font-black bg-red-600 text-white shadow-lg shadow-red-200 hover:bg-red-700 transition-all active:scale-[0.98]"
            >
              تأكيد الحذف
            </button>
          </div>
        </div>
      </motion.div>
    </div>
  );
}

// Sub-components for cleaner structure
function NavButton({ active, onClick, icon, label }: { active: boolean, onClick: () => void, icon: React.ReactNode, label: string }) {
  return (
    <button onClick={onClick} className={`w-full flex items-center gap-3 px-4 py-3.5 rounded-2xl transition-all font-bold ${active ? 'bg-orange-600 text-white shadow-lg shadow-orange-100' : 'text-slate-500 hover:bg-slate-50 hover:text-slate-900 border border-transparent'}`}>
      <span className={active ? 'text-white' : 'text-slate-400'}>{icon}</span>
      <span className="text-sm">{label}</span>
    </button>
  );
}

function StatCard({ label, value, color, active, onClick }: { label: string, value: number, color: string, active: boolean, onClick: () => void }) {
  const themes: any = {
    orange: active ? 'bg-orange-600 text-white shadow-orange-200' : 'bg-orange-50 text-orange-600 hover:bg-orange-100',
    green: active ? 'bg-green-600 text-white shadow-green-200' : 'bg-green-50 text-green-600 hover:bg-green-100',
    red: active ? 'bg-red-600 text-white shadow-red-200' : 'bg-red-50 text-red-600 hover:bg-red-100',
    slate: active ? 'bg-slate-900 text-white shadow-slate-200' : 'bg-slate-50 text-slate-800 hover:bg-slate-100',
    black: active ? 'bg-black text-white shadow-black' : 'bg-slate-50 text-slate-900 hover:bg-slate-100',
    indigo: active ? 'bg-indigo-600 text-white shadow-indigo-200' : 'bg-indigo-50 text-indigo-600 hover:bg-indigo-100'
  };

  return (
    <button onClick={onClick} className={`p-5 rounded-3xl text-center transition-all border border-transparent ${themes[color]} group shadow-sm`}>
      <div className="text-2xl font-black mb-1">{value}</div>
      <div className="text-[10px] font-bold opacity-80">{label}</div>
    </button>
  );
}

function InputField({ label, value, onChange, placeholder, type = 'text', icon, required, action }: any) {
  return (
    <div className="space-y-1.5 flex-1">
      <div className="flex items-center justify-between px-1">
        <label className="text-[10px] font-bold text-slate-400">{label} {required && '*'}</label>
        {action}
      </div>
      <div className="relative group">
        {icon && <div className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 group-focus-within:text-orange-500 transition-colors">{icon}</div>}
        <input 
          type={type} 
          value={value} 
          onChange={e => onChange(e.target.value)} 
          placeholder={placeholder}
          className={`w-full bg-slate-50 border border-slate-100 rounded-xl py-2.5 outline-none focus:ring-4 focus:ring-orange-500/10 focus:border-orange-200 transition-all text-sm font-medium ${icon ? 'pr-10' : 'px-4'}`}
        />
      </div>
    </div>
  );
}

function SettingsSection({ title, icon, children }: any) {
  return (
    <div className="bg-white p-8 rounded-[2rem] border border-slate-200 shadow-sm space-y-6">
      <div className="flex items-center gap-3">
         <div className="w-10 h-10 bg-slate-50 rounded-xl flex items-center justify-center">
           {icon}
         </div>
         <h3 className="font-bold text-lg text-slate-800">{title}</h3>
      </div>
      {children}
    </div>
  );
}

function HubSpotOverview({ accountInfo, contacts, totalContacts, onSearchChange, onRoleChange, uniqueRoles, selectedIds, onToggleSelect, onToggleSelectAll, onSendSelected, sending, hasSessionTitle }: any) {
  return (
    <div className="bg-white rounded-[2.5rem] border border-slate-200 p-8 shadow-inner mb-8 space-y-10">
      <div className="flex flex-col md:flex-row gap-8">
         <div className="bg-slate-50/50 p-6 rounded-2xl flex-1 border border-slate-100">
           <span className="text-[10px] font-bold text-slate-400 block mb-2">معلومات الحساب</span>
           <div className="flex items-center gap-4">
              <div className="w-12 h-12 bg-white rounded-xl shadow-sm border border-slate-100 flex items-center justify-center font-black text-orange-600 text-xl">{accountInfo?.name?.[0] || 'H'}</div>
              <div>
                <p className="font-bold text-slate-800">{accountInfo?.name || 'جاري التحميل...'}</p>
                <p className="font-mono text-xs text-slate-400">Portal ID: {accountInfo?.portalId || '...'}</p>
              </div>
           </div>
         </div>
         <div className="bg-slate-50/50 p-6 rounded-2xl flex-1 border border-slate-100">
           <span className="text-[10px] font-bold text-slate-400 block mb-2">نطاق الوصول</span>
           <div className="flex items-center gap-3">
              <Globe className="text-blue-500" size={18} />
              <p className="text-sm font-bold text-slate-700">موصول بـ HubSpot CRM</p>
           </div>
           <p className="text-[10px] text-slate-400 mt-2">إجمالي الجهات المستخرجة: {totalContacts}</p>
         </div>
      </div>

      <div className="space-y-6">
        <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
           <h3 className="font-bold flex items-center gap-2"><Users size={16} /> استعراض كامل القاعدة (أحدث 100)</h3>
           <div className="flex flex-wrap items-center gap-3">
              <div className="relative">
                <Search size={14} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400" />
                <input type="text" onChange={e => onSearchChange(e.target.value)} placeholder="بحث..." className="bg-slate-50 border border-slate-100 rounded-xl py-2 pr-9 pl-4 text-xs outline-none focus:ring-2 focus:ring-orange-500/20" />
              </div>
              <select onChange={e => onRoleChange(e.target.value)} className="bg-slate-50 border border-slate-100 rounded-xl py-2 px-4 text-xs outline-none">
                <option value="all">كل المناصب</option>
                {uniqueRoles.map((r: string) => <option key={r} value={r}>{r}</option>)}
              </select>
              {selectedIds.size > 0 && (
                <button 
                  onClick={onSendSelected} 
                  disabled={sending}
                  className="bg-orange-600 text-white px-4 py-2 rounded-xl text-xs font-bold hover:shadow-lg disabled:opacity-50"
                >
                  إرسال للـ ({selectedIds.size}) مختارين
                </button>
              )}
           </div>
        </div>

        <div className="overflow-x-auto rounded-3xl border border-slate-100">
          <table className="w-full text-right text-xs">
            <thead className="bg-slate-50 font-bold text-slate-500 border-b border-slate-100">
              <tr>
                <th className="px-6 py-4 w-12"><input type="checkbox" onChange={onToggleSelectAll} className="w-4 h-4 rounded" /></th>
                <th className="px-6 py-4">الاسم</th>
                <th className="px-6 py-4 text-center">المسمى</th>
                <th className="px-6 py-4 text-center">المنصب</th>
                <th className="px-6 py-4">البريد</th>
                <th className="px-6 py-4">الملخص</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {contacts.map((c: Contact) => (
                <tr key={c.id} className={`hover:bg-slate-50/80 transition-colors ${selectedIds.has(c.id) ? 'bg-orange-50/40' : ''}`}>
                  <td className="px-6 py-4"><input type="checkbox" checked={selectedIds.has(c.id)} onChange={() => onToggleSelect(c.id)} className="w-4 h-4 rounded" /></td>
                  <td className="px-6 py-4 font-bold text-slate-800">{c.properties.firstname} {c.properties.lastname}</td>
                  <td className="px-6 py-4 text-slate-500 text-center">{c.properties.jobtitle || '—'}</td>
                  <td className="px-6 py-4 text-center">
                    {c.properties.role ? (
                        <span className="inline-block bg-orange-600 text-white px-3 py-1.5 rounded-lg font-black shadow-sm whitespace-nowrap leading-normal">
                        {c.properties.role}
                      </span>
                    ) : '—'}
                  </td>
                  <td className="px-6 py-4 font-mono text-slate-400">{c.properties.email}</td>
                  <td className="px-6 py-4 max-w-md whitespace-pre-wrap leading-relaxed text-slate-600">{c.properties.summary || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function LoadingScreen() {
  return (
    <div className="min-h-screen bg-slate-900 flex flex-col items-center justify-center text-white p-6">
      <motion.div
        animate={{ 
          scale: [1, 1.1, 1],
          opacity: [0.5, 1, 0.5]
        }}
        transition={{ duration: 2, repeat: Infinity }}
      >
        <Sparkles size={60} className="text-orange-500 mb-6" />
      </motion.div>
      <h2 className="text-2xl font-black mb-2 animate-pulse">دروب جارٍ التحميل...</h2>
      <p className="text-slate-400">نجهز لك عالمك الخاص</p>
    </div>
  );
}

