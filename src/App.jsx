import React, { useState, useRef, useEffect, useMemo } from 'react';
import { Users, FileScan, Table as TableIcon, Plus, Trash2, Upload, CheckCircle, AlertCircle, Loader2, Save, ClipboardPaste, Camera, Download, Filter, Lock, User, UserPlus, LogIn, LogOut, ShieldCheck } from 'lucide-react';

// --- Constants & Config ---
const STORAGE_PREFIX = 'sdq-smart-scanner-v1';
const ACCOUNTS_KEY = `${STORAGE_PREFIX}:accounts`;
const SESSION_KEY = `${STORAGE_PREFIX}:active-teacher`;
const GEMINI_MODEL = 'gemini-3.6-flash';

const readJson = (key, fallback) => {
  try {
    const value = localStorage.getItem(key);
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
};

const writeJson = (key, value) => {
  localStorage.setItem(key, JSON.stringify(value));
};

const teacherDataKey = (username) => `${STORAGE_PREFIX}:teacher:${username}:data`;

const hashPassword = async (password) => {
  const bytes = new TextEncoder().encode(password);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('');
};

const ASSESSMENT_TYPES = [
  { id: 'student', label: 'ฉบับ นักเรียนประเมินตนเอง' },
  { id: 'teacher', label: 'ฉบับ ครูประเมินนักเรียน' },
  { id: 'parent', label: 'ฉบับ ผู้ปกครองประเมินนักเรียน' }
];

const REVERSE_ITEMS = [7, 11, 14, 21, 25]; 
const CATEGORIES = {
  emotion: { label: 'อารมณ์', items: [3, 8, 13, 16, 24] },
  conduct: { label: 'ด้านเกเร', items: [5, 7, 12, 18, 22] },
  hyperactivity: { label: 'ไม่อยู่นิ่ง', items: [2, 10, 15, 21, 25] },
  peer: { label: 'สัมพันธ์เพื่อน', items: [6, 11, 14, 19, 23] },
  prosocial: { label: 'ด้านสังคม', items: [1, 4, 9, 17, 20] }
};

// --- Helper Functions ---
const calculateCategoryScore = (scores, categoryItems) => {
  if (!scores || scores.length !== 25) return 0;
  return categoryItems.reduce((sum, itemNumber) => {
    let score = scores[itemNumber - 1]; 
    if (score === null || score === undefined) return sum;
    if (REVERSE_ITEMS.includes(itemNumber)) {
      if (score === 0) score = 2;
      else if (score === 2) score = 0;
    }
    return sum + score;
  }, 0);
};

const fileToBase64 = (file) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.readAsDataURL(file);
  reader.onload = () => resolve(reader.result);
  reader.onerror = error => reject(error);
});

const getLevenshteinDistance = (a, b) => {
  const matrix = [];
  for (let i = 0; i <= b.length; i++) { matrix[i] = [i]; }
  for (let j = 0; j <= a.length; j++) { matrix[0][j] = j; }
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min( matrix[i - 1][j - 1] + 1, matrix[i][j - 1] + 1, matrix[i - 1][j] + 1 );
      }
    }
  }
  return matrix[b.length][a.length];
};

// --- Main Component ---
export default function App() {
  // --- Auth & Profile State ---
  const [activeTeacher, setActiveTeacher] = useState(() => {
    try {
      const savedSession = sessionStorage.getItem(SESSION_KEY);
      return savedSession ? JSON.parse(savedSession) : null;
    } catch {
      return null;
    }
  });
  const [dataHydrated, setDataHydrated] = useState(false);
  
  const [loginMode, setLoginMode] = useState('login'); 
  const [authForm, setAuthForm] = useState({ username: '', password: '', name: '' });
  const [authLoading, setAuthLoading] = useState(false);
  const [authError, setAuthError] = useState('');

  // --- App State ---
  const [activeTab, setActiveTab] = useState('scan');
  const [students, setStudents] = useState([]);
  const [sdqData, setSdqData] = useState({}); 
  const [filterRoom, setFilterRoom] = useState('all');
  
  // Scan State
  const [scanType, setScanType] = useState('student');
  const [scanImage, setScanImage] = useState(null);
  const [imageBase64, setImageBase64] = useState(null);
  const [imageMimeType, setImageMimeType] = useState('image/jpeg');
  const [isScanning, setIsScanning] = useState(false);
  const [scanResult, setScanResult] = useState(null); 
  const [selectedStudentId, setSelectedStudentId] = useState('');
  const [scanError, setScanError] = useState('');
  const [inputMode, setInputMode] = useState('upload'); 
  const [geminiApiKey, setGeminiApiKey] = useState(() => sessionStorage.getItem(`${STORAGE_PREFIX}:gemini-key`) || '');

  // Student Form State
  const [newStudent, setNewStudent] = useState({ room: '', studentId: '', name: '', gender: 'ชาย' });
  const [importTargetRoom, setImportTargetRoom] = useState('');
  const [pasteData, setPasteData] = useState(''); 

  // UI State
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [alertMessage, setAlertMessage] = useState(null);

  const fileInputRef = useRef(null);
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const streamRef = useRef(null);

  // --- Local browser storage ---
  useEffect(() => {
    if (!activeTeacher) {
      setStudents([]);
      setSdqData({});
      setDataHydrated(false);
      return;
    }
    const savedData = readJson(teacherDataKey(activeTeacher.username), { students: [], sdqData: {} });
    setStudents(Array.isArray(savedData.students) ? savedData.students : []);
    setSdqData(savedData.sdqData && typeof savedData.sdqData === 'object' ? savedData.sdqData : {});
    setDataHydrated(true);
  }, [activeTeacher]);

  useEffect(() => {
    if (!activeTeacher || !dataHydrated) return;
    writeJson(teacherDataKey(activeTeacher.username), { students, sdqData, updatedAt: Date.now() });
  }, [activeTeacher, dataHydrated, students, sdqData]);

  useEffect(() => {
    if (geminiApiKey) sessionStorage.setItem(`${STORAGE_PREFIX}:gemini-key`, geminiApiKey);
    else sessionStorage.removeItem(`${STORAGE_PREFIX}:gemini-key`);
  }, [geminiApiKey]);

  // --- Computed State ---
  const availableRooms = useMemo(() => {
    const rooms = new Set(students.map(s => s.room).filter(Boolean));
    return Array.from(rooms).sort();
  }, [students]);

  const displayedStudents = useMemo(() => {
    if (filterRoom === 'all') return students;
    return students.filter(s => s.room === filterRoom);
  }, [students, filterRoom]);

  // --- Auth Handlers ---
  const handleAuthSubmit = async (e) => {
    e.preventDefault();
    setAuthLoading(true);
    setAuthError('');
    
    const usernameKey = authForm.username.toLowerCase().trim();
    if (!usernameKey || !authForm.password) {
        setAuthError('กรุณากรอกข้อมูลให้ครบถ้วน');
        setAuthLoading(false); return;
    }

    try {
      const accounts = readJson(ACCOUNTS_KEY, {});
      const passwordHash = await hashPassword(authForm.password);
      
      if (loginMode === 'register') {
        if (!authForm.name) {
            setAuthError('กรุณาระบุชื่อคุณครู');
            setAuthLoading(false); return;
        }
        if (accounts[usernameKey]) {
            setAuthError('ชื่อผู้ใช้งานนี้มีคนใช้แล้ว กรุณาเปลี่ยนใหม่');
        } else {
            accounts[usernameKey] = {
                username: usernameKey,
                passwordHash,
                name: authForm.name,
                createdAt: Date.now()
            };
            writeJson(ACCOUNTS_KEY, accounts);
            const teacher = { username: usernameKey, name: authForm.name };
            sessionStorage.setItem(SESSION_KEY, JSON.stringify(teacher));
            setActiveTeacher(teacher);
        }
      } else {
        const account = accounts[usernameKey];
        if (account) {
            if (account.passwordHash === passwordHash) {
                const teacher = { username: account.username, name: account.name };
                sessionStorage.setItem(SESSION_KEY, JSON.stringify(teacher));
                setActiveTeacher(teacher);
            } else {
                setAuthError('รหัสผ่านไม่ถูกต้อง');
            }
        } else {
            setAuthError('ไม่พบชื่อผู้ใช้งานนี้ในระบบ');
        }
      }
    } catch (err) {
      console.error(err);
      setAuthError('เกิดข้อผิดพลาดในการบันทึกข้อมูล กรุณาลองใหม่');
    }
    setAuthLoading(false);
  };

  const handleLogout = () => {
      sessionStorage.removeItem(SESSION_KEY);
      setActiveTeacher(null);
      setAuthForm({ username: '', password: '', name: '' });
  };

  // --- Camera Logic ---
  const startCamera = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
      streamRef.current = stream;
      if (videoRef.current) videoRef.current.srcObject = stream;
    } catch (err) {
      setAlertMessage("ไม่สามารถเข้าถึงกล้องได้ กรุณาตรวจสอบการอนุญาต (Camera Permission)");
      setInputMode('upload');
    }
  };

  const stopCamera = () => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
  };

  const capturePhoto = () => {
    if (videoRef.current && canvasRef.current) {
      const video = videoRef.current;
      const canvas = canvasRef.current;
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const context = canvas.getContext('2d');
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      const dataUrl = canvas.toDataURL('image/jpeg');
      setScanImage(dataUrl);
      setImageBase64(dataUrl.split(',')[1]);
      setImageMimeType('image/jpeg');
      stopCamera();
      setInputMode('upload');
    }
  };

  useEffect(() => {
    if (inputMode === 'camera' && activeTab === 'scan') startCamera();
    else stopCamera();
    return () => stopCamera();
  }, [inputMode, activeTab]);

  // --- Data Mutations (saved in this browser) ---
  const handleAddStudent = (e) => {
    e.preventDefault();
    if (!newStudent.name || !activeTeacher) return; 
    const newId = Date.now().toString();
    const studentDataToSave = { 
        id: newId, 
        room: newStudent.room || '-',
        studentId: newStudent.studentId || '-',
        name: newStudent.name,
        gender: newStudent.gender
    };
    
    setStudents(current => [...current, studentDataToSave]);
    setNewStudent({ ...newStudent, studentId: '', name: '', gender: 'ชาย' });
  };

  const handleDeleteStudent = (id) => {
    if (!activeTeacher) return;
    setStudents(current => current.filter(student => student.id !== id));
    setSdqData(current => {
      const next = { ...current };
      delete next[id];
      return next;
    });
  };

  const handleDeleteRoom = (roomName) => {
    const isConfirmed = window.confirm(`คุณแน่ใจหรือไม่ว่าต้องการลบรายชื่อนักเรียน "ห้อง ${roomName}" ทั้งหมด?`);
    if (isConfirmed && activeTeacher) {
      const idsToDelete = new Set(students.filter(student => student.room === roomName).map(student => student.id));
      setStudents(current => current.filter(student => !idsToDelete.has(student.id)));
      setSdqData(current => Object.fromEntries(Object.entries(current).filter(([id]) => !idsToDelete.has(id))));
    }
  };

  const executeDeleteAll = () => {
    if (!activeTeacher) return;
    setShowDeleteConfirm(false);
    setStudents([]);
    setSdqData({});
    setFilterRoom('all');
    setAlertMessage('ลบรายชื่อนักเรียนทั้งหมดเรียบร้อยแล้ว');
  };

  const handlePasteImport = () => {
    if (!pasteData.trim() || !activeTeacher) return;

    const rows = pasteData.trim().split('\n');
    const importedStudents = [];

    rows.forEach((row, index) => {
      let cols = row.split('\t').map(c => c.trim()).filter(Boolean);
      if (cols.length >= 1) { 
        let room = importTargetRoom || '-'; 
        let studentId = '';
        let name = '';
        let gender = ''; 

        if (cols.length > 1 && (cols[0].includes('/') || cols[0].includes('.') || cols[0].length <= 6) && !importTargetRoom) {
            room = cols.shift(); 
        }

        const genderIdx = cols.findIndex(c => c === 'ชาย' || c === 'หญิง');
        if (genderIdx > -1) { gender = cols[genderIdx]; cols.splice(genderIdx, 1); }

        let nameIdx = cols.findIndex(c => c.startsWith('ด.ช.') || c.startsWith('ด.ญ.') || c.startsWith('นาย') || c.startsWith('นาง'));
        if (nameIdx === -1 && cols.length > 0) nameIdx = cols.indexOf(cols.reduce((a, b) => a.length > b.length ? a : b, ""));
        if (nameIdx > -1) { name = cols[nameIdx]; cols.splice(nameIdx, 1); }

        if (cols.length > 0) {
             const numericCols = cols.filter(c => /\d/.test(c));
             studentId = numericCols.length > 0 ? numericCols[numericCols.length - 1] : cols[cols.length - 1];
        }

        if (!gender && name) {
            if (name.startsWith('ด.ช.') || name.startsWith('นาย')) gender = 'ชาย';
            else if (name.startsWith('ด.ญ.') || name.startsWith('นาง')) gender = 'หญิง';
            else gender = 'ชาย'; 
        }

        if (name) { 
          importedStudents.push({
            id: `imported-${Date.now()}-${index}`,
            room, studentId: studentId || '-', name, gender
          });
        }
      }
    });

    if (importedStudents.length > 0) {
      setStudents(current => [...current, ...importedStudents]);
      setPasteData('');
      setAlertMessage(`นำเข้ารายชื่อสำเร็จ ${importedStudents.length} คน ${importTargetRoom ? `ไปยังห้อง ${importTargetRoom}` : ''}`);
    } else {
      setAlertMessage('ไม่พบข้อมูลชื่อนักเรียน กรุณาตรวจสอบรูปแบบการคัดลอก');
    }
  };

  // --- AI Scan Logic ---
  const handleImageUpload = async (e) => {
    const file = e.target.files[0];
    if (file) {
      setScanImage(URL.createObjectURL(file));
      setImageMimeType(file.type || 'image/jpeg');
      setScanResult(null);
      setScanError('');
      try {
        const base64 = await fileToBase64(file);
        setImageBase64(base64.split(',')[1]);
      } catch (err) { setScanError('เกิดข้อผิดพลาดในการอ่านไฟล์ภาพ'); }
    }
  };

  const processScanWithAI = async () => {
    if (!imageBase64) return;
    if (!geminiApiKey.trim()) {
      setScanError('กรุณาใส่ Gemini API Key สำหรับการอ่านแบบประเมิน หรือเลือก “กรอกคะแนนเอง”');
      return;
    }
    setIsScanning(true);
    setScanError('');
    setScanResult(null);

    try {
      const promptText = `คุณคือผู้เชี่ยวชาญด้านการอ่านข้อมูลจากกระดาษแบบประเมิน SDQ ของไทย\nหน้าที่ของคุณคือ:\n1. อ่าน "ชื่อ-สกุล" ของนักเรียนที่เขียนอยู่ด้านบน\n2. ดูตารางพฤติกรรม 25 ข้อ สังเกตรอยขีดเขียน (เครื่องหมายถูก, กากบาท หรือวงกลม) ในช่องตัวเลือก\n3. แปลงผลในแต่ละข้อดังนี้:\n- ถ้าทำเครื่องหมายช่อง "ไม่จริง" (ซ้ายสุด) ให้ค่า = 0\n- ถ้าทำเครื่องหมายช่อง "ค่อนข้างจริง" (ตรงกลาง) ให้ค่า = 1\n- ถ้าทำเครื่องหมายช่อง "จริง" (ขวาสุด) ให้ค่า = 2\n- ถ้าข้อไหนไม่มีการกา ให้ใส่ null\nส่งกลับมาเป็นรูปแบบ JSON เท่านั้น ห้ามมีข้อความอื่นปน:\n{\n"studentName": "ชื่อที่อ่านได้",\n"scores": [ผลข้อ1, ผลข้อ2, ..., ผลข้อ25]\n}`;
      const payload = { contents: [{ role: "user", parts: [{ text: promptText }, { inlineData: { mimeType: imageMimeType, data: imageBase64 } }] }], generationConfig: { responseMimeType: "application/json", temperature: 0.1 } };
      
      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': geminiApiKey.trim()
        },
        body: JSON.stringify(payload)
      });

      if (!response.ok) throw new Error(`API Error: ${response.status}`);
      const result = await response.json();
      const aiResponseText = result.candidates?.[0]?.content?.parts?.[0]?.text;
      
      if (!aiResponseText) throw new Error("ไม่ได้รับข้อมูลจาก AI");
      const parsedData = JSON.parse(aiResponseText);
      
      if (!parsedData.scores || parsedData.scores.length !== 25) throw new Error("AI อ่านคะแนนได้ไม่ครบ 25 ข้อ กรุณาตรวจสอบภาพถ่ายว่าชัดเจนหรือไม่");
      setScanResult(parsedData);
      
      if (parsedData.studentName && students.length > 0) {
        const cleanName = (name) => name.replace(/^(ด\.ช\.|ด\.ญ\.|เด็กชาย|เด็กหญิง|นาย|นางสาว|นาง)\s*/g, '').replace(/\s+/g, '');
        const aiNameCleaned = cleanName(parsedData.studentName);
        const studentsToSearch = filterRoom === 'all' ? students : displayedStudents;
        
        let bestMatchId = '';
        let minDistance = Infinity;

        for (const student of studentsToSearch) {
          const studentNameCleaned = cleanName(student.name);
          if (aiNameCleaned === studentNameCleaned) { bestMatchId = student.id; minDistance = 0; break; }
          const distance = getLevenshteinDistance(aiNameCleaned, studentNameCleaned);
          if (distance < minDistance) { minDistance = distance; bestMatchId = student.id; }
        }

        if (bestMatchId && minDistance < 15) setSelectedStudentId(bestMatchId);
        else setSelectedStudentId(''); 
      }
    } catch (error) {
      setScanError(`เกิดข้อผิดพลาด: ${error.message || 'ระบบไม่สามารถประมวลผลภาพได้ กรุณาลองใหม่อีกครั้ง'}`);
    } finally { setIsScanning(false); }
  };

  const startManualEntry = () => {
    setScanError('');
    setScanResult({
      studentName: 'กรอกคะแนนด้วยตนเอง',
      scores: Array(25).fill(null)
    });
  };

  const updateScannedScore = (index, value) => {
    setScanResult(current => {
      if (!current) return current;
      const scores = [...current.scores];
      scores[index] = value === '' ? null : Number(value);
      return { ...current, scores };
    });
  };

  const saveScannedData = () => {
    if (!selectedStudentId || !scanResult || !scanResult.scores || !activeTeacher) {
      setAlertMessage("กรุณาเลือกชื่อนักเรียนก่อนบันทึก"); return;
    }
    if (scanResult.scores.some(score => score === null)) {
      setAlertMessage("กรุณาตรวจคะแนนให้ครบทั้ง 25 ข้อก่อนบันทึก");
      return;
    }
    setSdqData(current => ({
      ...current,
      [selectedStudentId]: {
        ...(current[selectedStudentId] || {}),
        [scanType]: scanResult.scores
      }
    }));
    
    setScanImage(null); setImageBase64(null); setScanResult(null); setSelectedStudentId('');
    if (fileInputRef.current) fileInputRef.current.value = '';
    setAlertMessage("บันทึกคะแนนเรียบร้อยแล้ว");
  };

  const exportToExcelHTML = () => {
    if (displayedStudents.length === 0) { setAlertMessage("ไม่มีข้อมูลนักเรียนสำหรับส่งออก"); return; }
    const typeLabel = ASSESSMENT_TYPES.find(t => t.id === scanType)?.label || scanType;
    const roomTitle = filterRoom === 'all' ? 'รวมทุกห้อง' : filterRoom;

    let htmlStr = `
      <html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns="http://www.w3.org/TR/REC-html40">
      <head><meta http-equiv="content-type" content="text/plain; charset=UTF-8"/><style>table { border-collapse: collapse; font-family: 'TH Sarabun New', 'TH SarabunPSK', sans-serif; font-size: 16pt; } th, td { border: 1px solid #000000; padding: 3px; vertical-align: middle; } .text-center { text-align: center; } .text-left { text-align: left; } .font-bold { font-weight: bold; } .bg-cyan { background-color: #CCFFFF; } .bg-yellow { background-color: #FFFF00; } .bg-blue { background-color: #3399FF; color: white; } .header-title { font-size: 18pt; font-weight: bold; } .vertical-text { mso-rotate: 90; text-align: center; white-space: nowrap; }</style></head>
      <body><table><tr><td colspan="5" class="bg-cyan text-center font-bold header-title">การแปลผลคะแนน SDQ ระบบดูแล ช่วยเหลือนักเรียน</td><td colspan="25" class="bg-yellow text-center font-bold header-title">(ฉบับ ${typeLabel})</td><td colspan="5" rowspan="2" class="bg-cyan text-center font-bold">สรุปผล 5 ด้าน<br/>(คะแนน)</td></tr><tr><td colspan="5" class="bg-cyan text-center font-bold header-title">ชั้น/ห้อง: ${roomTitle}</td><td colspan="25" class="bg-cyan text-center font-bold">ระดับคะแนน (ไม่จริง-0 / ค่อนข้างจริง-1 / จริง-2)</td></tr><tr><td class="bg-cyan text-center font-bold">ที่</td><td class="bg-cyan text-center font-bold">ห้อง</td><td class="bg-cyan text-center font-bold">ID</td><td class="bg-cyan text-center font-bold">ชื่อ-สกุล</td><td class="bg-cyan text-center font-bold">เพศ</td>`;

    for (let i = 1; i <= 25; i++) htmlStr += `<td class="${REVERSE_ITEMS.includes(i) ? 'bg-blue' : 'bg-cyan'} text-center font-bold">${i}</td>`;
    htmlStr += `<td class="bg-cyan vertical-text font-bold">อารมณ์</td><td class="bg-cyan vertical-text font-bold">ด้านเกเร</td><td class="bg-cyan vertical-text font-bold">ไม่อยู่นิ่ง</td><td class="bg-cyan vertical-text font-bold">สัมพันธ์เพื่อน</td><td class="bg-cyan vertical-text font-bold">ด้านสังคม</td></tr>`;

    const roomsToExport = filterRoom === 'all' ? availableRooms : [filterRoom];
    roomsToExport.forEach(room => {
        displayedStudents.filter(s => s.room === room).forEach((student, index) => {
            const scores = sdqData[student.id]?.[scanType] || Array(25).fill(null);
            const emoScore = calculateCategoryScore(scores, CATEGORIES.emotion.items);
            const conScore = calculateCategoryScore(scores, CATEGORIES.conduct.items);
            const hypScore = calculateCategoryScore(scores, CATEGORIES.hyperactivity.items);
            const peerScore = calculateCategoryScore(scores, CATEGORIES.peer.items);
            const proScore = calculateCategoryScore(scores, CATEGORIES.prosocial.items);

            htmlStr += `<tr><td class="text-center">${index + 1}</td><td class="text-center">${student.room}</td><td class="text-center" style="mso-number-format:'\@';">${student.studentId}</td><td class="text-left">${student.name}</td><td class="text-center">${student.gender}</td>`;
            scores.forEach(s => htmlStr += `<td class="text-center">${s !== null ? s : ''}</td>`);
            htmlStr += `<td class="text-center bg-cyan">${scores.includes(null) ? '-' : emoScore}</td><td class="text-center bg-cyan">${scores.includes(null) ? '-' : conScore}</td><td class="text-center bg-cyan">${scores.includes(null) ? '-' : hypScore}</td><td class="text-center bg-cyan">${scores.includes(null) ? '-' : peerScore}</td><td class="text-center bg-cyan">${scores.includes(null) ? '-' : proScore}</td></tr>`;
        });
    });

    htmlStr += `<tr><td colspan="35" style="border:none; height: 30px;"></td></tr><tr><td colspan="10" style="border:none; text-align:center;">(ลงชื่อ) ...................................................................</td><td colspan="10" style="border:none; text-align:center;">(ลงชื่อ) ...................................................................</td><td colspan="15" style="border:none; text-align:center;">(ลงชื่อ) ...................................................................</td></tr><tr><td colspan="10" style="border:none; text-align:center;">(...................................................................)</td><td colspan="10" style="border:none; text-align:center;">(...................................................................)</td><td colspan="15" style="border:none; text-align:center;">(...................................................................)</td></tr><tr><td colspan="10" style="border:none; text-align:center;">ครูประจำชั้น</td><td colspan="10" style="border:none; text-align:center;">ครูแนะแนว/หัวหน้าระดับ</td><td colspan="15" style="border:none; text-align:center;">ผู้อำนวยการโรงเรียน</td></tr></table></body></html>`;

    const blob = new Blob([htmlStr], { type: 'application/vnd.ms-excel;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a'); link.href = url;
    link.setAttribute('download', `SDQ_${typeLabel}_${roomTitle.replace(/[/\\?%*:|"<>]/g, '-')}.xls`);
    document.body.appendChild(link); link.click(); document.body.removeChild(link);
    setTimeout(() => setAlertMessage("ดาวน์โหลด Excel สำเร็จ!\n\nหมายเหตุ: เมื่อเปิดไฟล์ Excel อาจมีหน้าต่างแจ้งเตือน 'รูปแบบไฟล์และนามสกุลไม่ตรงกัน' ให้กด 'Yes' หรือ 'ใช่' เพื่อเปิดไฟล์ได้ตามปกติครับ"), 1000);
  };

  // --- UI Renders ---

  // --- LOGIN SCREEN ---
  if (!activeTeacher) {
    return (
        <div className="min-h-screen bg-gradient-to-br from-blue-600 to-indigo-900 flex items-center justify-center p-4 font-sans">
            <div className="max-w-4xl w-full bg-white rounded-2xl shadow-2xl overflow-hidden flex flex-col md:flex-row">
                
                <div className="hidden md:flex md:w-1/2 bg-blue-50 p-12 flex-col justify-center relative overflow-hidden">
                    <div className="absolute -top-24 -right-24 w-64 h-64 bg-blue-200 rounded-full mix-blend-multiply filter blur-3xl opacity-50"></div>
                    <div className="absolute -bottom-24 -left-24 w-64 h-64 bg-indigo-200 rounded-full mix-blend-multiply filter blur-3xl opacity-50"></div>
                    <div className="relative z-10">
                        <div className="bg-white p-4 inline-block rounded-2xl shadow-md mb-6">
                            <ShieldCheck className="w-12 h-12 text-blue-600" />
                        </div>
                        <h2 className="text-3xl font-bold text-gray-800 mb-4 leading-tight">ยินดีต้อนรับสู่<br/><span className="text-blue-600">SDQ Smart Scanner</span></h2>
                        <p className="text-gray-600 text-lg mb-6">ระบบช่วยบันทึกและจัดการคะแนนประเมินพฤติกรรมนักเรียน พร้อมตรวจทานผลก่อนบันทึกทุกครั้ง</p>
                        <ul className="space-y-3 text-gray-600">
                            <li className="flex items-center"><CheckCircle className="w-5 h-5 text-green-500 mr-2"/> แยกข้อมูลตามบัญชีคุณครูในอุปกรณ์นี้</li>
                            <li className="flex items-center"><CheckCircle className="w-5 h-5 text-green-500 mr-2"/> บันทึกอัตโนมัติในเบราว์เซอร์</li>
                            <li className="flex items-center"><CheckCircle className="w-5 h-5 text-green-500 mr-2"/> รองรับมือถือ แท็บเล็ต และคอมพิวเตอร์</li>
                        </ul>
                    </div>
                </div>

                <div className="w-full md:w-1/2 p-8 sm:p-12">
                    <div className="text-center mb-8">
                        <div className="md:hidden bg-blue-50 p-3 inline-block rounded-full mb-4">
                             <ShieldCheck className="w-8 h-8 text-blue-600" />
                        </div>
                        <h3 className="text-2xl font-bold text-gray-800">{loginMode === 'login' ? 'เข้าสู่ระบบบัญชีของคุณ' : 'สร้างบัญชีผู้ใช้งานใหม่'}</h3>
                        <p className="text-gray-500 mt-2 text-sm">
                            {loginMode === 'login' ? 'กรุณากรอกชื่อผู้ใช้และรหัสผ่านเพื่อจัดการข้อมูลนักเรียน' : 'สร้างบัญชีเพื่อจัดเก็บข้อมูลประเมิน SDQ ของคุณอย่างเป็นส่วนตัว'}
                        </p>
                    </div>

                    <form onSubmit={handleAuthSubmit} className="space-y-5">
                        {loginMode === 'register' && (
                            <div>
                                <label className="block text-sm font-medium text-gray-700 mb-1">ชื่อ-สกุล คุณครู</label>
                                <div className="relative">
                                    <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none"><User className="h-5 w-5 text-gray-400" /></div>
                                    <input type="text" required value={authForm.name} onChange={e => setAuthForm({...authForm, name: e.target.value})} className="pl-10 w-full p-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition-colors" placeholder="เช่น ครูสมศรี รักเรียน" />
                                </div>
                            </div>
                        )}
                        <div>
                            <label className="block text-sm font-medium text-gray-700 mb-1">ชื่อผู้ใช้งาน (Username)</label>
                            <div className="relative">
                                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none"><User className="h-5 w-5 text-gray-400" /></div>
                                <input type="text" required value={authForm.username} onChange={e => setAuthForm({...authForm, username: e.target.value})} className="pl-10 w-full p-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 transition-colors" placeholder="ตั้งชื่อผู้ใช้งานภาษาอังกฤษหรือตัวเลข" />
                            </div>
                        </div>
                        <div>
                            <label className="block text-sm font-medium text-gray-700 mb-1">รหัสผ่าน (Password)</label>
                            <div className="relative">
                                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none"><Lock className="h-5 w-5 text-gray-400" /></div>
                                <input type="password" required value={authForm.password} onChange={e => setAuthForm({...authForm, password: e.target.value})} className="pl-10 w-full p-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 transition-colors" placeholder="••••••••" />
                            </div>
                        </div>

                        {authError && (
                            <div className="p-3 bg-red-50 border border-red-200 text-red-600 rounded-lg text-sm flex items-start">
                                <AlertCircle className="w-4 h-4 mr-2 flex-shrink-0 mt-0.5" /> {authError}
                            </div>
                        )}

                        <button type="submit" disabled={authLoading} className="w-full bg-blue-600 hover:bg-blue-700 text-white font-medium p-3 rounded-lg shadow-md hover:shadow-lg transition-all flex justify-center items-center">
                            {authLoading ? <Loader2 className="w-5 h-5 animate-spin" /> : (loginMode === 'login' ? <><LogIn className="w-5 h-5 mr-2"/> เข้าสู่ระบบ</> : <><UserPlus className="w-5 h-5 mr-2"/> สมัครใช้งาน</>)}
                        </button>
                    </form>

                    <div className="mt-8 text-center text-sm text-gray-600 border-t pt-6">
                        {loginMode === 'login' ? 'ยังไม่มีบัญชีใช่หรือไม่? ' : 'มีบัญชีอยู่แล้วใช่หรือไม่? '}
                        <button onClick={() => { setLoginMode(loginMode === 'login' ? 'register' : 'login'); setAuthError(''); }} className="font-semibold text-blue-600 hover:text-blue-800 hover:underline transition-colors">
                            {loginMode === 'login' ? 'สมัครใช้งานที่นี่' : 'เข้าสู่ระบบ'}
                        </button>
                    </div>
                    <p className="mt-5 text-xs leading-relaxed text-amber-700 bg-amber-50 border border-amber-200 rounded-lg p-3">
                      เวอร์ชัน GitHub Pages เก็บข้อมูลไว้ในเบราว์เซอร์เครื่องนี้ ไม่ซิงก์ข้ามเครื่อง และไม่ควรใช้บนอุปกรณ์สาธารณะ
                    </p>
                </div>
            </div>
        </div>
    );
  }

  // --- MAIN APP (LOGGED IN) ---
  const renderTabButton = (id, label, Icon) => (
    <button onClick={() => setActiveTab(id)} className={`flex items-center px-4 py-3 text-sm font-medium transition-colors whitespace-nowrap ${activeTab === id ? 'border-b-2 border-blue-600 text-blue-600 bg-blue-50' : 'text-gray-600 hover:text-blue-600 hover:bg-gray-50'}`}>
      <Icon className="w-4 h-4 mr-2" />{label}
    </button>
  );

  return (
    <div className="min-h-screen bg-gray-100 font-sans pb-10">
      <header className="bg-white shadow-sm border-b sticky top-0 z-30">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center py-3 gap-3">
            <h1 className="text-xl sm:text-2xl font-bold text-gray-800 flex items-center">
              <FileScan className="w-7 h-7 mr-3 text-blue-600 flex-shrink-0" /> SDQ Smart Scanner
            </h1>
            
            <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3 w-full sm:w-auto">
                <div className="flex items-center space-x-2 bg-gray-50 p-1.5 rounded-lg border flex-1 sm:flex-none">
                    <Filter className="w-4 h-4 text-gray-500 ml-1 flex-shrink-0" />
                    <select value={filterRoom} onChange={(e) => setFilterRoom(e.target.value)} className="text-sm border-none bg-transparent focus:ring-0 text-gray-700 font-medium w-full sm:w-auto outline-none cursor-pointer">
                        <option value="all">ดูข้อมูล: รวมทุกห้อง</option>
                        {availableRooms.map(room => <option key={room} value={room}>ห้อง: {room}</option>)}
                    </select>
                </div>
                
                <div className="flex items-center justify-between sm:justify-end bg-blue-50 p-1.5 px-3 rounded-lg border border-blue-100">
                    <div className="flex items-center text-sm font-medium text-blue-800 mr-4 whitespace-nowrap">
                        <User className="w-4 h-4 mr-1.5" /> {activeTeacher.name}
                    </div>
                    <button onClick={handleLogout} className="text-red-500 hover:text-red-700 p-1 hover:bg-red-50 rounded transition-colors" title="ออกจากระบบ">
                        <LogOut className="w-4 h-4" />
                    </button>
                </div>
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 mt-6">
        <div className="bg-white rounded-t-lg border-b flex overflow-x-auto shadow-sm hide-scrollbar">
          {renderTabButton('scan', 'สแกนแบบประเมิน (AI)', FileScan)}
          {renderTabButton('table', 'ตารางคะแนน', TableIcon)}
          {renderTabButton('students', 'จัดการรายชื่อ/ชั้นเรียน', Users)}
        </div>

        <div className="bg-white rounded-b-lg shadow-sm p-4 sm:p-6 min-h-[600px]">
          
          {/* TAB 1: SCAN */}
          {activeTab === 'scan' && (
            <div className="grid md:grid-cols-2 gap-8">
              <div className="space-y-6">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">เลือกประเภทแบบประเมิน</label>
                  <select value={scanType} onChange={(e) => setScanType(e.target.value)} className="w-full p-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500">
                    {ASSESSMENT_TYPES.map(type => <option key={type.id} value={type.id}>{type.label}</option>)}
                  </select>
                </div>

                <div className="rounded-xl border border-blue-100 bg-blue-50 p-4">
                  <label className="block text-sm font-semibold text-blue-900 mb-2">Gemini API Key สำหรับอ่านภาพด้วย AI</label>
                  <input
                    type="password"
                    value={geminiApiKey}
                    onChange={(e) => setGeminiApiKey(e.target.value)}
                    className="w-full p-2.5 border border-blue-200 rounded-lg bg-white focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                    placeholder="ใส่ API Key เฉพาะเมื่อใช้ AI"
                    autoComplete="off"
                  />
                  <p className="mt-2 text-xs leading-relaxed text-blue-700">
                    Key จะเก็บเฉพาะแท็บนี้ เมื่อกดวิเคราะห์ ภาพแบบประเมินจะถูกส่งตรงไปยัง Gemini API โปรดจำกัดสิทธิ์ Key และอย่านำ Key ไปเผยแพร่
                    {' '}<a href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer" className="font-semibold underline">สร้าง API Key</a>
                  </p>
                </div>

                {!scanImage && (
                  <div className="flex bg-gray-200 p-1 rounded-lg">
                    <button onClick={() => setInputMode('upload')} className={`flex-1 flex justify-center items-center py-2.5 text-sm font-medium rounded-md transition-colors ${inputMode === 'upload' ? 'bg-white shadow text-blue-700' : 'text-gray-600 hover:text-gray-800'}`}>
                      <Upload className="w-4 h-4 mr-2" /> อัปโหลดไฟล์
                    </button>
                    <button onClick={() => setInputMode('camera')} className={`flex-1 flex justify-center items-center py-2.5 text-sm font-medium rounded-md transition-colors ${inputMode === 'camera' ? 'bg-white shadow text-blue-700' : 'text-gray-600 hover:text-gray-800'}`}>
                      <Camera className="w-4 h-4 mr-2" /> ถ่ายรูป
                    </button>
                  </div>
                )}

                {inputMode === 'camera' && !scanImage ? (
                  <div className="border-2 border-gray-300 rounded-xl overflow-hidden bg-black relative">
                    <video ref={videoRef} autoPlay playsInline className="w-full h-[60vh] sm:h-80 object-cover" />
                    <canvas ref={canvasRef} className="hidden" />
                    <div className="absolute bottom-6 left-0 right-0 flex justify-center">
                      <button onClick={capturePhoto} className="bg-white text-blue-600 font-bold py-3 px-8 rounded-full shadow-lg hover:bg-blue-50 transition-colors flex items-center border-4 border-blue-100">
                        <Camera className="w-6 h-6 mr-2" /> ถ่ายภาพ
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="border-2 border-dashed border-gray-300 rounded-xl p-8 text-center hover:bg-gray-50 transition-colors relative min-h-[250px] flex flex-col justify-center">
                    <input type="file" accept="image/*" onChange={handleImageUpload} ref={fileInputRef} className="absolute inset-0 w-full h-full opacity-0 cursor-pointer" />
                    {!scanImage ? (
                      <div className="flex flex-col items-center pointer-events-none">
                        <Upload className="w-12 h-12 text-gray-400 mb-4" />
                        <p className="text-gray-600 font-medium">คลิกหรือลากไฟล์ภาพมาวางที่นี่</p>
                        <p className="text-sm text-gray-400 mt-2">รองรับไฟล์ JPG, PNG</p>
                      </div>
                    ) : (
                      <div className="relative">
                        <img src={scanImage} alt="Scanned form" className="max-h-80 mx-auto rounded shadow-sm" />
                        <button onClick={(e) => { e.preventDefault(); setScanImage(null); setImageBase64(null); setScanResult(null); setInputMode('upload'); if(fileInputRef.current) fileInputRef.current.value = ''; }} className="absolute -top-3 -right-3 bg-red-500 text-white rounded-full p-2 shadow-md hover:bg-red-600 z-10">
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    )}
                  </div>
                )}

                <div className="grid sm:grid-cols-2 gap-3">
                  <button onClick={processScanWithAI} disabled={!imageBase64 || !geminiApiKey.trim() || isScanning} className={`w-full py-3.5 px-4 rounded-lg flex justify-center items-center font-medium text-white transition-colors shadow-sm ${!imageBase64 || !geminiApiKey.trim() ? 'bg-gray-300 cursor-not-allowed' : 'bg-blue-600 hover:bg-blue-700'}`}>
                    {isScanning ? <><Loader2 className="w-5 h-5 mr-2 animate-spin" /> กำลังประมวลผล...</> : <><FileScan className="w-5 h-5 mr-2" /> วิเคราะห์ด้วย AI</>}
                  </button>
                  <button onClick={startManualEntry} disabled={isScanning} className="w-full py-3.5 px-4 rounded-lg flex justify-center items-center font-medium text-blue-700 bg-white border border-blue-200 hover:bg-blue-50 transition-colors shadow-sm">
                    <ClipboardPaste className="w-5 h-5 mr-2" /> กรอกคะแนนเอง
                  </button>
                </div>

                {scanError && (
                  <div className="p-4 bg-red-50 text-red-700 rounded-lg flex items-start border border-red-200">
                    <AlertCircle className="w-5 h-5 mr-2 flex-shrink-0 mt-0.5" /><span>{scanError}</span>
                  </div>
                )}
              </div>

              <div className="bg-gray-50 rounded-xl p-4 sm:p-6 border border-gray-200">
                <h3 className="text-lg font-semibold text-gray-800 mb-4 border-b pb-2">ผลการสแกน และ บันทึก</h3>
                {!scanResult ? (
                  <div className="flex flex-col items-center justify-center h-48 sm:h-64 text-gray-400">
                    <CheckCircle className="w-12 h-12 sm:w-16 sm:h-16 mb-4 opacity-20" />
                    <p className="text-sm sm:text-base">อัปโหลดและกดวิเคราะห์ เพื่อดูผลลัพธ์ที่นี่</p>
                  </div>
                ) : (
                  <div className="space-y-6 animate-in fade-in duration-300">
                    <div className="bg-white p-4 rounded-lg shadow-sm border border-blue-100">
                      <p className="text-sm text-gray-500 mb-1">ชื่อที่ AI อ่านได้จากกระดาษ:</p>
                      <p className="font-semibold text-lg text-blue-800">{scanResult.studentName || 'ไม่สามารถระบุชื่อได้'}</p>
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-2">จับคู่กับนักเรียนในระบบ <span className="text-red-500">*</span></label>
                      <select value={selectedStudentId} onChange={(e) => setSelectedStudentId(e.target.value)} className="w-full p-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 bg-white">
                        <option value="">-- เลือกนักเรียน --</option>
                        {displayedStudents.map(s => <option key={s.id} value={s.id}>[{s.room}] {s.studentId !== '-' ? s.studentId : ''} {s.name}</option>)}
                      </select>
                      {filterRoom !== 'all' && <p className="text-xs text-orange-600 mt-1.5">*แสดงเฉพาะนักเรียนห้อง {filterRoom}</p>}
                    </div>

                    <div>
                      <p className="text-sm font-medium text-gray-700 mb-2">ตรวจและแก้คะแนนให้ครบทั้ง 25 ข้อก่อนบันทึก:</p>
                      <div className="grid grid-cols-5 gap-1.5 sm:gap-2">
                        {scanResult.scores.map((score, idx) => (
                          <div key={idx} className="bg-white text-center p-1.5 sm:p-2 rounded border border-gray-200 text-sm flex flex-col">
                            <span className="text-[10px] sm:text-xs text-gray-400">ข้อ {idx + 1}</span>
                            <select
                              aria-label={`คะแนนข้อ ${idx + 1}`}
                              value={score === null ? '' : score}
                              onChange={(e) => updateScannedScore(idx, e.target.value)}
                              className={`mt-1 w-full rounded border border-gray-200 bg-white py-1 text-center font-bold ${score === 2 ? 'text-green-600' : score === 1 ? 'text-yellow-600' : score === 0 ? 'text-gray-700' : 'text-red-500'}`}
                            >
                              <option value="">-</option>
                              <option value="0">0</option>
                              <option value="1">1</option>
                              <option value="2">2</option>
                            </select>
                          </div>
                        ))}
                      </div>
                      <p className="mt-3 text-xs leading-relaxed text-amber-700 bg-amber-50 border border-amber-200 rounded-lg p-3">
                        ระบบนี้ช่วยคีย์และคำนวณคะแนนเบื้องต้น ไม่ใช่เครื่องมือวินิจฉัย ควรตรวจเทียบกับแบบประเมินต้นฉบับทุกครั้ง
                      </p>
                    </div>

                    <button onClick={saveScannedData} disabled={!selectedStudentId} className={`w-full py-3.5 px-4 rounded-lg flex justify-center items-center font-medium transition-colors shadow-sm ${!selectedStudentId ? 'bg-gray-300 text-gray-500 cursor-not-allowed' : 'bg-green-600 hover:bg-green-700 text-white'}`}>
                      <Save className="w-5 h-5 mr-2 flex-shrink-0" /> ยืนยันและบันทึกคะแนน
                    </button>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* TAB 2: DATA TABLE */}
          {activeTab === 'table' && (
            <div className="space-y-4">
              <div className="flex flex-col md:flex-row justify-between items-start md:items-center mb-4 gap-3">
                <h2 className="text-xl font-bold text-gray-800">ตารางผลคะแนน {filterRoom !== 'all' ? `(ห้อง ${filterRoom})` : ''}</h2>
                <div className="flex flex-wrap gap-2 w-full md:w-auto">
                  <select value={scanType} onChange={(e) => setScanType(e.target.value)} className="p-2.5 border border-gray-300 rounded-lg shadow-sm flex-1 sm:flex-none text-sm bg-white">
                    {ASSESSMENT_TYPES.map(type => <option key={type.id} value={type.id}>{type.label}</option>)}
                  </select>

                  <button onClick={exportToExcelHTML} className="px-4 py-2.5 bg-blue-600 text-white rounded-lg border border-blue-700 hover:bg-blue-700 flex items-center justify-center shadow-sm transition-colors flex-1 sm:flex-none whitespace-nowrap font-medium">
                    <Download className="w-4 h-4 mr-2 flex-shrink-0" /> ส่งออก Excel
                  </button>
                </div>
              </div>

              <div className="overflow-x-auto shadow-sm pb-4 relative w-full">
                <table className="w-full text-sm text-left whitespace-nowrap border-collapse border border-black min-w-[1000px]">
                  <thead className="text-xs text-gray-700 bg-gray-100">
                    <tr>
                      <th colSpan="4" className="px-4 py-3 border border-black bg-[#CCFFFF] text-center font-bold text-base text-gray-800">ข้อมูลนักเรียน</th>
                      <th colSpan="25" className="px-2 py-3 border border-black bg-yellow-200 text-center font-bold text-base text-gray-800">
                        ระดับคะแนน ({ASSESSMENT_TYPES.find(t => t.id === scanType)?.label})
                      </th>
                      <th colSpan="5" className="px-2 py-3 border border-black bg-[#CCFFFF] text-center font-bold text-base text-gray-800">สรุปผล 5 ด้าน</th>
                    </tr>
                    <tr>
                      <th className="px-3 py-2 border border-black bg-[#CCFFFF] text-center">ที่</th>
                      <th className="px-3 py-2 border border-black bg-[#CCFFFF] text-center">ID</th>
                      <th className="px-4 py-2 border border-black bg-[#CCFFFF] text-center min-w-[200px] sticky left-0 z-10 shadow-[2px_0_5px_rgba(0,0,0,0.05)]">ชื่อ-สกุล</th>
                      <th className="px-3 py-2 border border-black bg-[#CCFFFF] text-center">เพศ</th>
                      
                      {Array.from({ length: 25 }, (_, i) => {
                        const isRev = REVERSE_ITEMS.includes(i + 1);
                        return <th key={i} className={`px-1 py-2 border border-black text-center font-bold min-w-[30px] text-gray-800 ${isRev ? 'bg-[#3399FF] text-white' : 'bg-[#CCFFFF]'}`}>{i + 1}</th>
                      })}
                      
                      <th className="border border-black bg-[#CCFFFF] p-0 align-middle"><div className="h-24 w-10 flex items-center justify-center mx-auto"><span className="transform -rotate-90 whitespace-nowrap block text-gray-800 font-semibold">อารมณ์</span></div></th>
                      <th className="border border-black bg-[#CCFFFF] p-0 align-middle"><div className="h-24 w-10 flex items-center justify-center mx-auto"><span className="transform -rotate-90 whitespace-nowrap block text-gray-800 font-semibold">ด้านเกเร</span></div></th>
                      <th className="border border-black bg-[#CCFFFF] p-0 align-middle"><div className="h-24 w-10 flex items-center justify-center mx-auto"><span className="transform -rotate-90 whitespace-nowrap block text-gray-800 font-semibold">ไม่อยู่นิ่ง</span></div></th>
                      <th className="border border-black bg-[#CCFFFF] p-0 align-middle"><div className="h-24 w-10 flex items-center justify-center mx-auto"><span className="transform -rotate-90 whitespace-nowrap block text-gray-800 font-semibold">สัมพันธ์เพื่อน</span></div></th>
                      <th className="border border-black bg-[#CCFFFF] p-0 align-middle"><div className="h-24 w-10 flex items-center justify-center mx-auto"><span className="transform -rotate-90 whitespace-nowrap block text-gray-800 font-semibold">ด้านสังคม</span></div></th>
                    </tr>
                  </thead>
                  <tbody>
                    {(filterRoom === 'all' ? availableRooms : [filterRoom]).map(room => {
                        const roomStudents = displayedStudents.filter(s => s.room === room);
                        if (roomStudents.length === 0) return null;

                        return (
                            <React.Fragment key={room}>
                                <tr>
                                    <td colSpan="34" className="bg-blue-100 py-2 px-4 font-bold text-blue-900 border border-black sticky left-0 z-10">
                                        รายชื่อนักเรียนชั้น/ห้อง: {room}
                                    </td>
                                </tr>
                                {roomStudents.map((student, index) => {
                                    const scores = sdqData[student.id]?.[scanType] || Array(25).fill(null);
                                    const emoScore = calculateCategoryScore(scores, CATEGORIES.emotion.items);
                                    const conScore = calculateCategoryScore(scores, CATEGORIES.conduct.items);
                                    const hypScore = calculateCategoryScore(scores, CATEGORIES.hyperactivity.items);
                                    const peerScore = calculateCategoryScore(scores, CATEGORIES.peer.items);
                                    const proScore = calculateCategoryScore(scores, CATEGORIES.prosocial.items);

                                    return (
                                        <tr key={student.id} className="bg-white hover:bg-gray-50">
                                        <td className="px-3 py-1.5 border border-black text-center">{index + 1}</td>
                                        <td className="px-3 py-1.5 border border-black text-center">{student.studentId}</td>
                                        <td className="px-4 py-1.5 border border-black font-medium sticky left-0 z-10 bg-inherit shadow-[2px_0_5px_rgba(0,0,0,0.05)]">{student.name}</td>
                                        <td className="px-3 py-1.5 border border-black text-center">{student.gender}</td>
                                        
                                        {scores.map((score, idx) => (
                                            <td key={idx} className="px-1 py-1.5 border border-black text-center text-gray-800">
                                            {score !== null ? score : ''}
                                            </td>
                                        ))}
                                        
                                        <td className="px-2 py-1.5 border border-black text-center font-semibold bg-cyan-50/30">{scores.includes(null) ? '-' : emoScore}</td>
                                        <td className="px-2 py-1.5 border border-black text-center font-semibold bg-cyan-50/30">{scores.includes(null) ? '-' : conScore}</td>
                                        <td className="px-2 py-1.5 border border-black text-center font-semibold bg-cyan-50/30">{scores.includes(null) ? '-' : hypScore}</td>
                                        <td className="px-2 py-1.5 border border-black text-center font-semibold bg-cyan-50/30">{scores.includes(null) ? '-' : peerScore}</td>
                                        <td className="px-2 py-1.5 border border-black text-center font-semibold bg-cyan-50/30">{scores.includes(null) ? '-' : proScore}</td>
                                        </tr>
                                    );
                                })}
                            </React.Fragment>
                        );
                    })}
                    {displayedStudents.length === 0 && (
                        <tr><td colSpan="34" className="p-8 border border-black text-center text-gray-500">ไม่พบข้อมูลนักเรียนในห้องที่เลือก</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* TAB 3: STUDENTS */}
          {activeTab === 'students' && (
            <div className="max-w-4xl mx-auto space-y-6">
              
              <div className="bg-blue-50 rounded-xl p-5 sm:p-6 border border-blue-100">
                <h3 className="text-lg font-bold text-blue-800 mb-4 flex items-center">
                  <Plus className="w-5 h-5 mr-2 flex-shrink-0" /> เพิ่มรายชื่อนักเรียน (ทีละคน)
                </h3>
                <form onSubmit={handleAddStudent} className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-6 gap-3 sm:gap-4 items-end">
                  <div className="md:col-span-1">
                    <label className="block text-sm font-medium text-gray-700 mb-1">ชั้น/ห้อง</label>
                    <input type="text" placeholder="ป.1/1" value={newStudent.room} onChange={e => setNewStudent({...newStudent, room: e.target.value})} className="w-full p-2.5 sm:p-2 border border-gray-300 rounded focus:ring-blue-500 bg-white" />
                  </div>
                  <div className="md:col-span-1">
                    <label className="block text-sm font-medium text-gray-700 mb-1">รหัส/ID</label>
                    <input type="text" value={newStudent.studentId} onChange={e => setNewStudent({...newStudent, studentId: e.target.value})} className="w-full p-2.5 sm:p-2 border border-gray-300 rounded focus:ring-blue-500 bg-white" />
                  </div>
                  <div className="sm:col-span-2 md:col-span-3">
                    <label className="block text-sm font-medium text-gray-700 mb-1">ชื่อ-สกุล <span className="text-red-500">*</span></label>
                    <input type="text" required value={newStudent.name} onChange={e => setNewStudent({...newStudent, name: e.target.value})} className="w-full p-2.5 sm:p-2 border border-gray-300 rounded focus:ring-blue-500 bg-white" />
                  </div>
                  <div className="sm:col-span-2 md:col-span-1 mt-2 sm:mt-0">
                    <button type="submit" className="w-full bg-blue-600 text-white p-3 sm:p-2 rounded hover:bg-blue-700 transition-colors shadow-sm font-medium">เพิ่มชื่อ</button>
                  </div>
                </form>
              </div>

              <div className="bg-green-50 rounded-xl p-5 sm:p-6 border border-green-100">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between mb-4 gap-3">
                  <h3 className="text-lg font-bold text-green-800 flex items-center">
                    <ClipboardPaste className="w-5 h-5 mr-2 flex-shrink-0" /> นำเข้าจาก Excel
                  </h3>
                  <div className="flex items-center justify-between bg-white p-2 rounded-lg border border-green-200 shadow-sm w-full sm:w-auto">
                    <label className="text-sm font-bold text-green-800 mr-2 whitespace-nowrap">นำเข้าห้อง:</label>
                    <input type="text" value={importTargetRoom} onChange={e => setImportTargetRoom(e.target.value)} placeholder="เช่น ป.1/1" className="p-1 border border-gray-300 rounded focus:ring-green-500 w-full sm:w-24 text-center font-medium text-blue-700" />
                  </div>
                </div>
                <p className="text-sm text-green-700 mb-3">คัดลอก: <b>รหัส | ชื่อ-สกุล | เพศ</b> (ลากคลุมแล้ว Ctrl+C) มาวางด้านล่าง</p>
                <textarea className="w-full p-3 border border-gray-300 rounded-lg focus:ring-green-500 min-h-[100px] font-mono text-sm bg-white" placeholder={`938\tด.ช.กันต์พิมุกต์\tชาย`} value={pasteData} onChange={(e) => setPasteData(e.target.value)}></textarea>
                <div className="mt-3 flex justify-end">
                  <button onClick={handlePasteImport} disabled={!pasteData.trim()} className={`w-full sm:w-auto px-6 py-3 sm:py-2.5 rounded-lg font-medium text-white transition-colors ${!pasteData.trim() ? 'bg-gray-400' : 'bg-green-600 hover:bg-green-700 shadow-sm'}`}>นำข้อมูลเข้าตาราง</button>
                </div>
              </div>

              <div className="mb-4 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3 pt-4 border-t">
                 <h2 className="text-xl font-bold text-gray-800">รายชื่อนักเรียนแยกตามห้อง</h2>
                 {students.length > 0 && (
                    <button onClick={() => setShowDeleteConfirm(true)} className="flex items-center justify-center text-red-600 hover:bg-red-50 text-sm font-medium py-2.5 px-4 rounded-lg border border-red-200 transition-colors w-full sm:w-auto whitespace-nowrap">
                      <Trash2 className="w-4 h-4 mr-2 flex-shrink-0" /> ลบรายชื่อทั้งหมดทุกห้อง
                    </button>
                  )}
              </div>

              {availableRooms.length === 0 ? (
                  <div className="bg-white rounded-xl border p-10 text-center text-gray-500 shadow-sm">ไม่มีข้อมูลนักเรียนในระบบ</div>
              ) : (
                  (filterRoom === 'all' ? availableRooms : [filterRoom]).map(room => {
                      const roomStudents = displayedStudents.filter(s => s.room === room);
                      if (roomStudents.length === 0) return null;

                      return (
                          <div key={room} className="bg-white rounded-xl border shadow-sm mb-6 overflow-hidden">
                              <div className="flex flex-col sm:flex-row justify-between sm:items-center p-4 border-b bg-blue-50 text-blue-900 gap-3">
                                  <h3 className="font-bold flex items-center text-lg">
                                      <Users className="w-5 h-5 mr-2 flex-shrink-0 text-blue-600" /> ห้อง: {room} 
                                      <span className="ml-3 text-sm font-semibold bg-white px-2.5 py-0.5 rounded-full text-blue-700 shadow-sm">{roomStudents.length} คน</span>
                                  </h3>
                                  <button onClick={() => handleDeleteRoom(room)} className="text-sm text-red-500 hover:text-red-700 hover:bg-red-50 py-1.5 px-3 rounded flex items-center transition-colors self-start sm:self-auto">
                                      <Trash2 className="w-4 h-4 mr-1.5" /> ลบห้องนี้
                                  </button>
                              </div>
                              <div className="overflow-x-auto w-full">
                                <table className="w-full text-left text-sm min-w-[500px]">
                                    <thead className="bg-gray-50 border-b">
                                        <tr>
                                            <th className="p-3 font-semibold text-gray-600 w-16 text-center">ที่</th>
                                            <th className="p-3 font-semibold text-gray-600 w-24">ID</th>
                                            <th className="p-3 font-semibold text-gray-600">ชื่อ-สกุล</th>
                                            <th className="p-3 font-semibold text-gray-600 w-20 text-center">เพศ</th>
                                            <th className="p-3 font-semibold text-gray-600 w-24 text-center">จัดการ</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {roomStudents.map((student, index) => (
                                            <tr key={student.id} className="border-b last:border-0 hover:bg-gray-50">
                                                <td className="p-3 text-gray-800 text-center">{index + 1}</td>
                                                <td className="p-3 text-gray-800">{student.studentId}</td>
                                                <td className="p-3 text-gray-800 font-medium">{student.name}</td>
                                                <td className="p-3 text-gray-800 text-center">{student.gender}</td>
                                                <td className="p-3 text-center">
                                                    <button onClick={() => handleDeleteStudent(student.id)} className="text-red-400 hover:text-red-600 p-2 hover:bg-red-50 rounded-full transition-colors" title="ลบนักเรียน">
                                                        <Trash2 className="w-4 h-4" />
                                                    </button>
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                              </div>
                          </div>
                      );
                  })
              )}
            </div>
          )}
        </div>

        {/* Delete Confirm Modal */}
        {showDeleteConfirm && (
          <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
            <div className="bg-white rounded-2xl max-w-md w-full p-6 sm:p-8 shadow-2xl animate-in zoom-in-95">
              <div className="flex items-center text-red-600 mb-5"><AlertCircle className="w-7 h-7 mr-3" /><h3 className="text-xl font-bold">ยืนยันการลบรายชื่อทั้งหมด</h3></div>
              <p className="text-gray-600 mb-8 leading-relaxed">คุณแน่ใจหรือไม่? <br/><span className="text-red-500 font-medium">ข้อมูลคะแนนทั้งหมดจะหายไปและไม่สามารถกู้คืนได้</span></p>
              <div className="flex flex-col-reverse sm:flex-row justify-end gap-3">
                <button onClick={() => setShowDeleteConfirm(false)} className="w-full sm:w-auto px-5 py-2.5 bg-gray-100 hover:bg-gray-200 rounded-lg transition-colors font-medium text-gray-700">ยกเลิก</button>
                <button onClick={executeDeleteAll} className="w-full sm:w-auto px-5 py-2.5 text-white bg-red-600 hover:bg-red-700 rounded-lg flex items-center justify-center transition-colors shadow-sm font-medium"><Trash2 className="w-4 h-4 mr-2" /> ยืนยันการลบ</button>
              </div>
            </div>
          </div>
        )}

        {alertMessage && (
          <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
            <div className="bg-white rounded-2xl max-w-sm w-full p-6 sm:p-8 text-center shadow-2xl animate-in zoom-in-95">
              <div className="w-14 h-14 bg-blue-100 text-blue-600 rounded-full flex items-center justify-center mx-auto mb-5"><AlertCircle className="w-7 h-7" /></div>
              <p className="text-gray-800 font-medium mb-8 whitespace-pre-line text-lg">{alertMessage}</p>
              <button onClick={() => setAlertMessage(null)} className="w-full py-3 bg-blue-600 hover:bg-blue-700 text-white font-medium rounded-lg transition-colors shadow-sm">ตกลง</button>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
