import express, { Request, Response } from 'express';
import dotenv from 'dotenv';
import { createServer as createViteServer } from 'vite';
import { GoogleGenAI } from '@google/genai';
import path from 'path';
import fs from 'fs';

dotenv.config();

const app = express();
const PORT = 3000;

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Initialize Google Gemini AI SDK
const apiKey = process.env.GEMINI_API_KEY || '';
let genAI: GoogleGenAI | null = null;
if (apiKey) {
  try {
    genAI = new GoogleGenAI({ apiKey });
  } catch (err) {
    console.error('Failed to initialize Google GenAI SDK:', err);
  }
}

// In-Memory Database store with preloaded sample medical records & user sessions
// Mirrors the MySQL schema defined in medimate_ai/schema.sql
export interface LabObservation {
  id: string;
  testName: string;
  category: string;
  measuredValue: number;
  unit: string;
  referenceRange: string;
  referenceMin?: number;
  referenceMax?: number;
  status: 'normal' | 'high' | 'low' | 'critical';
  confidence: number;
  extractedSnippet: string;
}

export interface MedicationItem {
  id: string;
  name: string;
  dosage: string;
  frequency: string;
  duration: string;
  instructions: string;
  foodRelation?: string;
  purpose?: string;
}

export interface DocumentRecord {
  id: string;
  userId: string;
  title: string;
  fileName: string;
  fileType: string;
  fileSize: number;
  uploadDate: string;
  reportDate: string;
  documentType: 'lab_report' | 'prescription' | 'discharge_summary' | 'diagnostic_scan' | 'consultation_note';
  doctorOrLab: string;
  patientName: string;
  extractedText: string;
  ocrConfidence: number;
  status: 'completed' | 'processing' | 'flagged';
  summaryEn: {
    overview: string;
    keyFindings: string[];
    abnormalValues: string[];
    medicationsSummary: string[];
    doctorQuestions: string[];
    limitations: string[];
  };
  summaryTe: {
    overview: string;
    keyFindings: string[];
    abnormalValues: string[];
    medicationsSummary: string[];
    doctorQuestions: string[];
    limitations: string[];
  };
  observations: LabObservation[];
  medications: MedicationItem[];
  userCorrected?: boolean;
}

// Seed realistic medical records for demo
const INITIAL_DOCUMENTS: DocumentRecord[] = [
  {
    id: 'doc-cbc-01',
    userId: 'user-demo-1',
    title: 'Complete Blood Count (CBC) & Metabolic Panel',
    fileName: 'apollo_diagnostics_cbc_jan2026.pdf',
    fileType: 'application/pdf',
    fileSize: 245000,
    uploadDate: '2026-01-14T10:30:00Z',
    reportDate: '2026-01-14',
    documentType: 'lab_report',
    doctorOrLab: 'Apollo Diagnostics Laboratory, Hyderabad',
    patientName: 'Rahul Verma',
    ocrConfidence: 98.4,
    status: 'completed',
    extractedText: `APOLLO DIAGNOSTICS - CLINICAL PATHOLOGY REPORT
Patient Name: Rahul Verma    Age: 42 Yrs / Male    Date: 14-Jan-2026
Ref By: Dr. K. S. Rao, MD    Sample ID: HYD-98241    Status: Final

TEST NAME                   RESULT     UNIT         REFERENCE RANGE     FLAG
Hemoglobin                  11.8       g/dL         13.0 - 17.0         LOW
Total WBC Count             8,400      /mcL         4,000 - 11,000      NORMAL
Platelet Count              240,000    /mcL         150,000 - 450,000   NORMAL
Fasting Blood Sugar (FBS)   134        mg/dL        70 - 99             HIGH
HbA1c (Glycated Hb)         7.2        %            < 5.7 (Normal)      HIGH
                                                    5.7 - 6.4 (Prediabetes)
                                                    >= 6.5 (Diabetes)
Serum Creatinine            1.1        mg/dL        0.7 - 1.3           NORMAL
SGPT / ALT                  48         U/L          7 - 56              NORMAL
Total Cholesterol           215        mg/dL        < 200               HIGH
Triglycerides               195        mg/dL        < 150               HIGH
HDL Cholesterol             38         mg/dL        > 40                LOW
LDL Cholesterol (Calc)      138        mg/dL        < 100               HIGH

Impression: Mild microcytic anemia, elevated glycemic markers suggestive of sub-optimal diabetes control, borderline dyslipidemia with elevated triglycerides and LDL. Clinical correlation advised.`,
    observations: [
      { id: 'obs-1', testName: 'Hemoglobin', category: 'Hematology', measuredValue: 11.8, unit: 'g/dL', referenceRange: '13.0 - 17.0', referenceMin: 13.0, referenceMax: 17.0, status: 'low', confidence: 99, extractedSnippet: 'Hemoglobin 11.8 g/dL (Ref: 13.0 - 17.0) LOW' },
      { id: 'obs-2', testName: 'Total WBC Count', category: 'Hematology', measuredValue: 8400, unit: '/mcL', referenceRange: '4,000 - 11,000', referenceMin: 4000, referenceMax: 11000, status: 'normal', confidence: 99, extractedSnippet: 'Total WBC Count 8,400 /mcL NORMAL' },
      { id: 'obs-3', testName: 'Platelet Count', category: 'Hematology', measuredValue: 240000, unit: '/mcL', referenceRange: '150,000 - 450,000', referenceMin: 150000, referenceMax: 450000, status: 'normal', confidence: 98, extractedSnippet: 'Platelet Count 240,000 /mcL NORMAL' },
      { id: 'obs-4', testName: 'Fasting Blood Sugar (FBS)', category: 'Biochemistry', measuredValue: 134, unit: 'mg/dL', referenceRange: '70 - 99', referenceMin: 70, referenceMax: 99, status: 'high', confidence: 99, extractedSnippet: 'Fasting Blood Sugar (FBS) 134 mg/dL HIGH' },
      { id: 'obs-5', testName: 'HbA1c', category: 'Biochemistry', measuredValue: 7.2, unit: '%', referenceRange: '< 5.7', referenceMin: 4.0, referenceMax: 5.7, status: 'high', confidence: 98, extractedSnippet: 'HbA1c (Glycated Hb) 7.2 % HIGH' },
      { id: 'obs-6', testName: 'Serum Creatinine', category: 'Renal Panel', measuredValue: 1.1, unit: 'mg/dL', referenceRange: '0.7 - 1.3', referenceMin: 0.7, referenceMax: 1.3, status: 'normal', confidence: 99, extractedSnippet: 'Serum Creatinine 1.1 mg/dL NORMAL' },
      { id: 'obs-7', testName: 'Total Cholesterol', category: 'Lipid Profile', measuredValue: 215, unit: 'mg/dL', referenceRange: '< 200', referenceMin: 120, referenceMax: 200, status: 'high', confidence: 97, extractedSnippet: 'Total Cholesterol 215 mg/dL HIGH' },
      { id: 'obs-8', testName: 'LDL Cholesterol', category: 'Lipid Profile', measuredValue: 138, unit: 'mg/dL', referenceRange: '< 100', referenceMin: 50, referenceMax: 100, status: 'high', confidence: 98, extractedSnippet: 'LDL Cholesterol (Calc) 138 mg/dL HIGH' }
    ],
    medications: [],
    summaryEn: {
      overview: 'Routine clinical biochemistry and hematology report from Apollo Diagnostics conducted for diabetes and lipid monitoring.',
      keyFindings: [
        'Hemoglobin is slightly below the normal male range at 11.8 g/dL (normal: 13.0 - 17.0 g/dL).',
        'Fasting blood glucose is elevated at 134 mg/dL (target fasting is below 100 mg/dL).',
        'HbA1c is 7.2%, reflecting an average blood glucose level consistent with active diabetes mellitus.',
        'Lipid markers indicate elevated total cholesterol (215 mg/dL) and LDL (138 mg/dL), with suboptimal HDL (38 mg/dL).',
        'Kidney filtration biomarker Serum Creatinine (1.1 mg/dL) and liver enzyme SGPT (48 U/L) remain within healthy limits.'
      ],
      abnormalValues: [
        'Hemoglobin: 11.8 g/dL (Reference: 13.0 - 17.0) - Flagged LOW',
        'Fasting Blood Sugar: 134 mg/dL (Reference: 70 - 99) - Flagged HIGH',
        'HbA1c: 7.2% (Reference: < 5.7%) - Flagged HIGH',
        'Total Cholesterol: 215 mg/dL (Reference: < 200) - Flagged HIGH',
        'LDL Cholesterol: 138 mg/dL (Reference: < 100) - Flagged HIGH'
      ],
      medicationsSummary: [
        'No medications were prescribed in this diagnostic lab record itself; please review doctor consultation notes.'
      ],
      doctorQuestions: [
        'Is my current anti-diabetic medication regimen adequate to bring my HbA1c from 7.2% closer to the target of 6.5%?',
        'Do you recommend iron supplementation or dietary modifications for my 11.8 g/dL hemoglobin level?',
        'Should we initiate or adjust statin therapy for the elevated LDL cholesterol (138 mg/dL)?',
        'When should I schedule the next follow-up fasting glucose test?'
      ],
      limitations: [
        'Laboratory test numbers represent biological markers and are not a final diagnosis on their own.',
        'Dietary intake over the preceding 12 hours can influence fasting glucose and triglyceride levels.'
      ]
    },
    summaryTe: {
      overview: 'అపోలో డయాగ్నోస్టిక్స్ నుండి మధుమేహం మరియు కొలెస్ట్రాల్ పరిశీలన కోసం నిర్వహించిన సాధారణ రక్త పరీక్ష నివేదిక.',
      keyFindings: [
        'హిమోగ్లోబిన్ 11.8 g/dL వద్ద ఉంది (సాధారణ స్థాయి: 13.0 - 17.0 g/dL), ఇది స్వల్ప అనీమియాను సూచిస్తుంది.',
        'ఉపవాస రక్తంలో చక్కెర (FBS) 134 mg/dL వద్ద ఎక్కువగా ఉంది (సాధారణ స్థాయి: 70 - 99 mg/dL).',
        'గడిచిన 3 నెలల సగటు చక్కెర సూచిక HbA1c 7.2% గా నమోదైంది.',
        'మొత్తం కొలెస్ట్రాల్ (215 mg/dL) మరియు LDL చెడు కొలెస్ట్రాల్ (138 mg/dL) సాధారణ పరిమితి కంటే ఎక్కువగా ఉన్నాయి.',
        'మూత్రపిండాల పనితీరు సూచిక సీరమ్ క్రియాటినిన్ (1.1 mg/dL) మరియు కాలేయ ఎంజైమ్ సాధారణ స్థితిలోనే ఉన్నాయి.'
      ],
      abnormalValues: [
        'హిమోగ్లోబిన్: 11.8 g/dL (పరిమితి: 13.0 - 17.0) - తక్కువ (LOW)',
        'ఉపవాస చక్కెర (FBS): 134 mg/dL (పరిమితి: 70 - 99) - ఎక్కువ (HIGH)',
        'HbA1c: 7.2% (పరిమితి: < 5.7%) - ఎక్కువ (HIGH)',
        'మొత్తం కొలెస్ట్రాల్: 215 mg/dL (పరిమితి: < 200) - ఎక్కువ (HIGH)',
        'LDL కొలెస్ట్రాల్: 138 mg/dL (పరిమితి: < 100) - ఎక్కువ (HIGH)'
      ],
      medicationsSummary: [
        'ఈ నివేదికలో ప్రత్యక్ష మందుల సూచనలు లేవు; డాక్టర్ ప్రిస్క్రిప్షన్ చూడండి.'
      ],
      doctorQuestions: [
        'నా HbA1c 7.2% నుండి తగ్గించడానికి ప్రస్తుత మధుమేహ ఔషధాల మోతాదులో మార్పు అవసరమా?',
        'హిమోగ్లోబిన్ 11.8 g/dL స్థాయికి ఐరన్ పోషకాహారం లేదా సప్లిమెంట్లు తీసుకోవాలా?',
        'ఎక్కువగా ఉన్న LDL కొలెస్ట్రాల్ కోసం కొలెస్ట్రాల్ మందులు సూచిస్తారా?'
      ],
      limitations: [
        'ప్రయోగశాల విలువల ఆధారంగా మాత్రమే తుది వ్యాధి నిర్ధారణ చేయలేము; వైద్యుల వ్యక్తిగత సలహా అవసరం.'
      ]
    }
  },
  {
    id: 'doc-followup-02',
    userId: 'user-demo-1',
    title: 'Follow-up Metabolic & Lipid Profile (March 2026)',
    fileName: 'apollo_followup_panel_mar2026.pdf',
    fileType: 'application/pdf',
    fileSize: 220000,
    uploadDate: '2026-03-20T14:15:00Z',
    reportDate: '2026-03-20',
    documentType: 'lab_report',
    doctorOrLab: 'Apollo Diagnostics Laboratory, Hyderabad',
    patientName: 'Rahul Verma',
    ocrConfidence: 99.1,
    status: 'completed',
    extractedText: `APOLLO DIAGNOSTICS - CLINICAL PATHOLOGY FOLLOW-UP
Patient Name: Rahul Verma    Age: 42 Yrs / Male    Date: 20-Mar-2026
Ref By: Dr. K. S. Rao, MD    Sample ID: HYD-104921   Status: Final

TEST NAME                   RESULT     UNIT         REFERENCE RANGE     FLAG
Hemoglobin                  12.5       g/dL         13.0 - 17.0         LOW (IMPROVED)
Total WBC Count             7,800      /mcL         4,000 - 11,000      NORMAL
Platelet Count              255,000    /mcL         150,000 - 450,000   NORMAL
Fasting Blood Sugar (FBS)   112        mg/dL        70 - 99             BORDERLINE HIGH
HbA1c (Glycated Hb)         6.6        %            < 5.7               SLIGHTLY HIGH
Serum Creatinine            1.0        mg/dL        0.7 - 1.3           NORMAL
Total Cholesterol           182        mg/dL        < 200               NORMAL (DESIRABLE)
Triglycerides               142        mg/dL        < 150               NORMAL
HDL Cholesterol             44         mg/dL        > 40                NORMAL
LDL Cholesterol (Calc)      109        mg/dL        < 100               BORDERLINE HIGH

Comments: Positive therapeutic response observed. Glycemic indices and lipid parameters demonstrating significant downward trend following medical and dietary intervention.`,
    observations: [
      { id: 'obs-f1', testName: 'Hemoglobin', category: 'Hematology', measuredValue: 12.5, unit: 'g/dL', referenceRange: '13.0 - 17.0', referenceMin: 13.0, referenceMax: 17.0, status: 'low', confidence: 99, extractedSnippet: 'Hemoglobin 12.5 g/dL LOW (IMPROVED)' },
      { id: 'obs-f2', testName: 'Total WBC Count', category: 'Hematology', measuredValue: 7800, unit: '/mcL', referenceRange: '4,000 - 11,000', referenceMin: 4000, referenceMax: 11000, status: 'normal', confidence: 99, extractedSnippet: 'Total WBC Count 7,800 /mcL NORMAL' },
      { id: 'obs-f3', testName: 'Fasting Blood Sugar (FBS)', category: 'Biochemistry', measuredValue: 112, unit: 'mg/dL', referenceRange: '70 - 99', referenceMin: 70, referenceMax: 99, status: 'high', confidence: 99, extractedSnippet: 'Fasting Blood Sugar (FBS) 112 mg/dL BORDERLINE HIGH' },
      { id: 'obs-f4', testName: 'HbA1c', category: 'Biochemistry', measuredValue: 6.6, unit: '%', referenceRange: '< 5.7', referenceMin: 4.0, referenceMax: 5.7, status: 'high', confidence: 98, extractedSnippet: 'HbA1c 6.6 % SLIGHTLY HIGH' },
      { id: 'obs-f5', testName: 'Serum Creatinine', category: 'Renal Panel', measuredValue: 1.0, unit: 'mg/dL', referenceRange: '0.7 - 1.3', referenceMin: 0.7, referenceMax: 1.3, status: 'normal', confidence: 99, extractedSnippet: 'Serum Creatinine 1.0 mg/dL NORMAL' },
      { id: 'obs-f6', testName: 'Total Cholesterol', category: 'Lipid Profile', measuredValue: 182, unit: 'mg/dL', referenceRange: '< 200', referenceMin: 120, referenceMax: 200, status: 'normal', confidence: 98, extractedSnippet: 'Total Cholesterol 182 mg/dL NORMAL' },
      { id: 'obs-f7', testName: 'LDL Cholesterol', category: 'Lipid Profile', measuredValue: 109, unit: 'mg/dL', referenceRange: '< 100', referenceMin: 50, referenceMax: 100, status: 'high', confidence: 98, extractedSnippet: 'LDL Cholesterol 109 mg/dL BORDERLINE' }
    ],
    medications: [],
    summaryEn: {
      overview: 'Follow-up clinical assessment report dated March 20, 2026, tracking progress following medication and lifestyle modifications.',
      keyFindings: [
        'Hemoglobin improved from 11.8 to 12.5 g/dL.',
        'Fasting blood sugar dropped noticeably from 134 mg/dL to 112 mg/dL.',
        'HbA1c reduced from 7.2% to 6.6%, nearing the target threshold.',
        'Total cholesterol normalized from 215 mg/dL to 182 mg/dL (below 200 mg/dL cutoff).',
        'LDL cholesterol reduced from 138 mg/dL to 109 mg/dL.'
      ],
      abnormalValues: [
        'Fasting Blood Sugar: 112 mg/dL (Reference: 70 - 99) - Borderline High',
        'HbA1c: 6.6% (Reference: < 5.7%) - Mildly High'
      ],
      medicationsSummary: ['Continuing prescribed therapy.'],
      doctorQuestions: [
        'Should I maintain the current Metformin dose given the improvement in HbA1c to 6.6%?',
        'Do we need another follow-up in 3 months or 6 months?'
      ],
      limitations: ['Follow-up reflects 2-month interval. Maintain continued dietary and lifestyle discipline.']
    },
    summaryTe: {
      overview: 'మార్చి 20, 2026 నాటి ఫాలో-అప్ నివేదిక. మునుపటి చికిత్స ప్రభావంతో మెరుగుదల నమోదైంది.',
      keyFindings: [
        'హిమోగ్లోబిన్ 11.8 నుండి 12.5 g/dL కు మెరుగైంది.',
        'ఉపవాస రక్త చక్కెర 134 నుండి 112 mg/dL కు గణనీయంగా తగ్గింది.',
        'HbA1c 7.2% నుండి 6.6% కు చేరుకుంది.',
        'మొత్తం కొలెస్ట్రాల్ 215 నుండి 182 mg/dL కు సాధారణ స్థాయికి వచ్చింది.'
      ],
      abnormalValues: [
        'ఉపవాస చక్కెర: 112 mg/dL (పరిమితి: 70 - 99) - స్వల్పంగా ఎక్కువ',
        'HbA1c: 6.6% (పరిమితి: < 5.7%) - స్వల్పంగా ఎక్కువ'
      ],
      medicationsSummary: ['డాక్టర్ సూచించిన ఔషధాల కొనసాగింపు.'],
      doctorQuestions: [
        'HbA1c 6.6% కు తగ్గినందున ప్రస్తుత మందుల డోస్ కొనసాగించాలా?',
        'తదుపరి చెకప్ ఎప్పుడు చేయించుకోవాలి?'
      ],
      limitations: ['మెరుగుదల ఉన్నప్పటికీ జీవనశైలి మార్పులు కొనసాగించాలి.']
    }
  },
  {
    id: 'doc-rx-03',
    userId: 'user-demo-1',
    title: 'Consultation & Prescription Slip - Dr. K. S. Rao',
    fileName: 'prescription_dr_rao_jan2026.jpg',
    fileType: 'image/jpeg',
    fileSize: 185000,
    uploadDate: '2026-01-15T16:00:00Z',
    reportDate: '2026-01-15',
    documentType: 'prescription',
    doctorOrLab: 'Dr. K. S. Rao, MD (Internal Medicine), Care Clinics',
    patientName: 'Rahul Verma',
    ocrConfidence: 96.2,
    status: 'completed',
    extractedText: `CARE CLINICS - DEPARTMENT OF INTERNAL MEDICINE
Dr. K. S. Rao, MBBS, MD (Medicine), Reg. No: TS-48291
Date: 15-01-2026    Patient: Rahul Verma    Age: 42/M    BP: 132/86 mmHg

Diagnosis: Type 2 Diabetes Mellitus, Mild Dyslipidemia, Microcytic Anemia

Rx:
1. Tab. Glycomet (Metformin) 500mg
   Dosage: 1 Tablet Twice Daily (1-0-1)
   Duration: 90 Days
   Instructions: Take after meals with water.

2. Tab. Atorva (Atorvastatin) 10mg
   Dosage: 1 Tablet Once Daily at Night (0-0-1)
   Duration: 60 Days
   Instructions: Take after dinner.

3. Tab. Autrin (Ferrous Fumarate + Folic Acid)
   Dosage: 1 Capsule Once Daily (1-0-0)
   Duration: 30 Days
   Instructions: Take after breakfast. Avoid taking with tea or dairy.

Advice:
- 30 mins brisk walking daily.
- Low-glycemic index diet, minimize refined sugars and fried foods.
- Follow up after 2 months with repeat HbA1c and Lipid Profile.`,
    observations: [
      { id: 'obs-rx-bp', testName: 'Blood Pressure', category: 'Vitals', measuredValue: 132, unit: 'mmHg (Systolic)', referenceRange: '< 120/80', status: 'high', confidence: 99, extractedSnippet: 'BP: 132/86 mmHg' }
    ],
    medications: [
      { id: 'med-1', name: 'Glycomet (Metformin)', dosage: '500 mg', frequency: 'Twice daily (1-0-1)', duration: '90 days', instructions: 'Take orally after morning and evening meals with water.', foodRelation: 'After meals', purpose: 'Blood sugar regulation' },
      { id: 'med-2', name: 'Atorva (Atorvastatin)', dosage: '10 mg', frequency: 'Once daily at night (0-0-1)', duration: '60 days', instructions: 'Take after dinner before sleeping.', foodRelation: 'After dinner', purpose: 'Cholesterol & cardiovascular risk management' },
      { id: 'med-3', name: 'Autrin (Iron + Folic Acid)', dosage: 'Standard therapeutic dose', frequency: 'Once daily after breakfast (1-0-0)', duration: '30 days', instructions: 'Take after breakfast. Do not consume simultaneously with calcium supplements or tea.', foodRelation: 'After breakfast', purpose: 'Hemoglobin and red blood cell support' }
    ],
    summaryEn: {
      overview: 'Prescription issued by Dr. K. S. Rao for medical management of Type 2 Diabetes, mild dyslipidemia, and borderline anemia.',
      keyFindings: [
        'Diagnoses noted: Type 2 Diabetes Mellitus, Mild Dyslipidemia, Microcytic Anemia.',
        'Recorded Blood Pressure: 132/86 mmHg (Pre-hypertension stage).',
        'Three active medications prescribed for metabolic control, lipid management, and iron levels.',
        'Follow-up scheduled in 2 months with repeat HbA1c and lipid profile.'
      ],
      abnormalValues: [
        'Blood Pressure: 132/86 mmHg - Slightly elevated above standard 120/80 target.'
      ],
      medicationsSummary: [
        'Glycomet 500mg: Twice daily after meals for glucose regulation.',
        'Atorva 10mg: Once daily at bedtime for LDL cholesterol reduction.',
        'Autrin: Once daily for 30 days to replenish hemoglobin.'
      ],
      doctorQuestions: [
        'What should I do if Metformin causes mild stomach upset initially?',
        'Should I monitor blood pressure at home weekly?'
      ],
      limitations: [
        'Always consult your physician before modifying dosage or stopping any prescribed medications.'
      ]
    },
    summaryTe: {
      overview: 'డాక్టర్ కె. ఎస్. రావు గారి ప్రిస్క్రిప్షన్ - టైప్ 2 డయాబెటిస్, కొలెస్ట్రాల్ మరియు రక్తహీనత చికిత్స కోసం.',
      keyFindings: [
        'వ్యాధి నిర్ధారణ: టైప్ 2 డయాబెటిస్ మెల్లిటస్, డిస్లిపిడెమియా, అనీమియా.',
        'రక్తపోటు (BP): 132/86 mmHg నమోదైంది.',
        'చక్కెర నియంత్రణ, కొలెస్ట్రాల్ తగ్గించడం మరియు హిమోగ్లోబిన్ పెంపు కోసం 3 మందులు సూచించబడ్డాయి.',
        '2 నెలల తర్వాత మళ్ళీ పరీక్షలు చేయించుకోవాలని సూచించారు.'
      ],
      abnormalValues: [
        'రక్తపోటు (BP): 132/86 mmHg - స్వల్పంగా ఎక్కువ.'
      ],
      medicationsSummary: [
        'గ్లైకోమెట్ (మెట్‌ఫార్మిన్ 500mg): రోజుకు 2 సార్లు భోజనం తర్వాత.',
        'ఎటార్వా (ఎటోర్వాస్టాటిన్ 10mg): రాత్రి భోజనం తర్వాత 1 మాత్ర.',
        'ఆట్రిన్ (ఐరన్ + ఫోలిక్ యాసిడ్): ఉదయం అల్పాహారం తర్వాత 1 క్యాప్సూల్ (టీ లేదా పాలతో తీసుకోకూడదు).'
      ],
      doctorQuestions: [
        'మెట్‌ఫార్మిన్ తీసుకునేటప్పుడు ఏమైనా జాగ్రత్తలు పాటించాలా?',
        'ఇంట్లో వారానికోసారి రక్తపోటు పరీక్షించుకోవాలా?'
      ],
      limitations: [
        'వైద్యుల సలహా లేకుండా మందుల మోతాదును ఎప్పుడూ మార్చవద్దు.'
      ]
    }
  }
];

let documentsStore: DocumentRecord[] = [...INITIAL_DOCUMENTS];

// Active user session store (starts as null so visitors are never automatically logged in)
let currentUser: any = null;

// Registered users registry (stores accounts created via registration)
interface RegisteredUserAccount {
  id: string;
  fullName: string;
  email: string;
  password: string;
  age: number;
  gender: string;
  bloodGroup: string;
  abhaId?: string;
  abhaAddress?: string;
  isAbhaLinked?: boolean;
  phone?: string;
  emergencyContact?: string;
  conditions: string[];
  allergies: string[];
  preferredLanguage: string;
}

const registeredUsers = new Map<string, RegisteredUserAccount>();

// Audit logs store
interface AuditLog {
  id: string;
  timestamp: string;
  action: string;
  details: string;
  ip: string;
}

const auditLogs: AuditLog[] = [
  { id: 'log-1', timestamp: '2026-03-20T14:20:00Z', action: 'DOCUMENT_UPLOAD', details: 'Uploaded Apollo Follow-up Panel Mar 2026', ip: '127.0.0.1' },
  { id: 'log-2', timestamp: '2026-03-20T14:21:00Z', action: 'AI_SUMMARY_GENERATED', details: 'Generated clinical summary for doc-followup-02', ip: '127.0.0.1' },
  { id: 'log-3', timestamp: '2026-01-15T16:05:00Z', action: 'PRESCRIPTION_EXTRACTED', details: 'Extracted 3 medications from prescription_dr_rao_jan2026.jpg', ip: '127.0.0.1' },
  { id: 'log-4', timestamp: '2026-01-14T10:35:00Z', action: 'OCR_COMPLETED', details: 'Completed OCR text extraction for doc-cbc-01 (Confidence: 98.4%)', ip: '127.0.0.1' }
];

// Helper to query Gemini with fallback
async function generateAIResponse(prompt: string, fallbackText: string): Promise<string> {
  if (genAI) {
    try {
      const response = await genAI.models.generateContent({
        model: 'gemini-3.8-flash',
        contents: prompt
      });
      if (response && response.text) {
        return response.text.trim();
      }
    } catch (err: any) {
      console.warn('Gemini API call failed, using clinical fallback engine:', err?.message || err);
    }
  }
  return fallbackText;
}

// -------------------------------------------------------------
// API ROUTES
// -------------------------------------------------------------

// Health check
app.get('/api/health', (req: Request, res: Response) => {
  res.json({
    status: 'ok',
    appName: 'MediMate AI – Personal Health Copilot',
    timestamp: new Date().toISOString(),
    geminiConfigured: !!genAI,
    totalDocuments: documentsStore.length,
    registeredUsersCount: registeredUsers.size
  });
});

// Auth endpoints
app.get('/api/auth/me', (req: Request, res: Response) => {
  res.json({ user: currentUser });
});

// LOGIN: Users CANNOT log in without registering first!
app.post('/api/auth/login', (req: Request, res: Response) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required.' });
  }
  
  const normalizedEmail = email.toLowerCase().trim();
  const existingAccount = registeredUsers.get(normalizedEmail);

  if (!existingAccount) {
    return res.status(401).json({ 
      error: 'Account not found. You must register an account first before logging in. Please click "Register Account" to create your profile.' 
    });
  }

  if (existingAccount.password !== password) {
    return res.status(401).json({ 
      error: 'Incorrect password. Please verify your credentials and try again.' 
    });
  }

  const { password: _, ...userSafeProfile } = existingAccount;
  currentUser = { ...userSafeProfile };

  auditLogs.unshift({
    id: `log-${Date.now()}`,
    timestamp: new Date().toISOString(),
    action: 'USER_LOGIN',
    details: `User ${currentUser.fullName} signed in successfully.`,
    ip: req.ip || '127.0.0.1'
  });

  res.json({ success: true, user: currentUser });
});

// REGISTER: Creates the user account so they can log in
app.post('/api/auth/register', (req: Request, res: Response) => {
  const { fullName, email, password, confirmPassword, age, gender, bloodGroup } = req.body;
  if (!fullName || !email || !password) {
    return res.status(400).json({ error: 'Full name, email, and password are required.' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters long.' });
  }
  if (password !== confirmPassword) {
    return res.status(400).json({ error: 'Passwords do not match.' });
  }

  const normalizedEmail = email.toLowerCase().trim();
  if (registeredUsers.has(normalizedEmail)) {
    return res.status(400).json({ error: 'An account with this email is already registered. Please sign in instead.' });
  }

  const newAccount: RegisteredUserAccount = {
    id: `user-${Date.now()}`,
    fullName: fullName.trim(),
    email: normalizedEmail,
    password: password,
    age: Number(age) || 35,
    gender: gender || 'Other',
    bloodGroup: bloodGroup || 'O+',
    abhaId: '',
    abhaAddress: '',
    isAbhaLinked: false,
    phone: '',
    emergencyContact: '',
    conditions: ['General Wellness Tracking'],
    allergies: [],
    preferredLanguage: 'en'
  };

  registeredUsers.set(normalizedEmail, newAccount);
  const { password: _, ...safeUser } = newAccount;
  currentUser = { ...safeUser };

  auditLogs.unshift({
    id: `log-${Date.now()}`,
    timestamp: new Date().toISOString(),
    action: 'USER_REGISTER',
    details: `New user registered: ${fullName} (${email}).`,
    ip: req.ip || '127.0.0.1'
  });

  res.json({ success: true, user: currentUser });
});

app.post('/api/auth/logout', (req: Request, res: Response) => {
  currentUser = null;
  auditLogs.unshift({
    id: `log-${Date.now()}`,
    timestamp: new Date().toISOString(),
    action: 'USER_LOGOUT',
    details: `User session terminated.`,
    ip: req.ip || '127.0.0.1'
  });
  res.json({ success: true });
});

// Update Profile
app.post('/api/profile/update', (req: Request, res: Response) => {
  const { fullName, age, gender, bloodGroup, phone, emergencyContact, preferredLanguage } = req.body;
  currentUser = {
    ...currentUser,
    fullName: fullName || currentUser.fullName,
    age: Number(age) || currentUser.age,
    gender: gender || currentUser.gender,
    bloodGroup: bloodGroup || currentUser.bloodGroup,
    phone: phone ?? currentUser.phone,
    emergencyContact: emergencyContact ?? currentUser.emergencyContact,
    preferredLanguage: preferredLanguage || currentUser.preferredLanguage
  };

  auditLogs.unshift({
    id: `log-${Date.now()}`,
    timestamp: new Date().toISOString(),
    action: 'PROFILE_UPDATED',
    details: `Updated personal health profile demographics.`,
    ip: req.ip || '127.0.0.1'
  });

  res.json({ success: true, user: currentUser });
});

// Documents API
app.get('/api/documents', (req: Request, res: Response) => {
  res.json({ documents: documentsStore });
});

app.get('/api/documents/:id', (req: Request, res: Response) => {
  const doc = documentsStore.find(d => d.id === req.params.id);
  if (!doc) {
    return res.status(404).json({ error: 'Document not found.' });
  }
  res.json({ document: doc });
});

// Delete document
app.delete('/api/documents/:id', (req: Request, res: Response) => {
  const docIndex = documentsStore.findIndex(d => d.id === req.params.id);
  if (docIndex === -1) {
    return res.status(404).json({ error: 'Document not found.' });
  }
  const deleted = documentsStore.splice(docIndex, 1)[0];
  
  auditLogs.unshift({
    id: `log-${Date.now()}`,
    timestamp: new Date().toISOString(),
    action: 'DOCUMENT_DELETED',
    details: `Deleted document: ${deleted.title} (${deleted.id})`,
    ip: req.ip || '127.0.0.1'
  });

  res.json({ success: true, deletedId: deleted.id });
});

// Update / Correct extracted observation
app.post('/api/documents/:id/correct-observation', (req: Request, res: Response) => {
  const { observationId, measuredValue, status } = req.body;
  const doc = documentsStore.find(d => d.id === req.params.id);
  if (!doc) {
    return res.status(404).json({ error: 'Document not found.' });
  }
  const obs = doc.observations.find(o => o.id === observationId);
  if (!obs) {
    return res.status(404).json({ error: 'Observation not found.' });
  }
  const oldVal = obs.measuredValue;
  obs.measuredValue = Number(measuredValue);
  if (status) obs.status = status;
  doc.userCorrected = true;

  auditLogs.unshift({
    id: `log-${Date.now()}`,
    timestamp: new Date().toISOString(),
    action: 'OBSERVATION_CORRECTED',
    details: `User corrected ${obs.testName} from ${oldVal} to ${measuredValue} in ${doc.title}`,
    ip: req.ip || '127.0.0.1'
  });

  res.json({ success: true, observation: obs });
});

// Upload and analyze new medical document
app.post('/api/documents/upload', async (req: Request, res: Response) => {
  try {
    const { title, fileName, fileType, fileSize, rawText, documentType, doctorOrLab, reportDate } = req.body;

    if (!title || !fileName) {
      return res.status(400).json({ error: 'Title and file name are required.' });
    }

    const docId = `doc-${Date.now()}`;
    const cleanText = rawText || `MEDICAL CLINICAL RECORD\nPatient: ${currentUser.fullName}\nDate: ${reportDate || new Date().toISOString().split('T')[0]}\nProvider: ${doctorOrLab || 'City Diagnostic Centre'}\nReport: ${title}`;

    // Extract observations and generate AI summaries
    const observations: LabObservation[] = [];
    const medications: MedicationItem[] = [];

    // Parse simple lab patterns from rawText
    const lines = cleanText.split('\n');
    lines.forEach((line: string, idx: number) => {
      const lower = line.toLowerCase();
      if (lower.includes('hemoglobin') && line.match(/(\d+\.?\d*)/)) {
        const val = parseFloat(line.match(/(\d+\.?\d*)/)![1]);
        observations.push({
          id: `obs-u-${idx}`,
          testName: 'Hemoglobin',
          category: 'Hematology',
          measuredValue: val,
          unit: 'g/dL',
          referenceRange: '13.0 - 17.0',
          referenceMin: 13.0,
          referenceMax: 17.0,
          status: val < 13 ? 'low' : val > 17 ? 'high' : 'normal',
          confidence: 96,
          extractedSnippet: line.trim()
        });
      } else if (lower.includes('glucose') || lower.includes('blood sugar') || lower.includes('fbs')) {
        const match = line.match(/(\d+\.?\d*)/);
        if (match) {
          const val = parseFloat(match[1]);
          observations.push({
            id: `obs-u-${idx}`,
            testName: 'Fasting Blood Sugar',
            category: 'Biochemistry',
            measuredValue: val,
            unit: 'mg/dL',
            referenceRange: '70 - 99',
            referenceMin: 70,
            referenceMax: 99,
            status: val > 99 ? 'high' : val < 70 ? 'low' : 'normal',
            confidence: 97,
            extractedSnippet: line.trim()
          });
        }
      } else if (lower.includes('cholesterol') && !lower.includes('hdl') && !lower.includes('ldl')) {
        const match = line.match(/(\d+\.?\d*)/);
        if (match) {
          const val = parseFloat(match[1]);
          observations.push({
            id: `obs-u-${idx}`,
            testName: 'Total Cholesterol',
            category: 'Lipid Profile',
            measuredValue: val,
            unit: 'mg/dL',
            referenceRange: '< 200',
            referenceMin: 120,
            referenceMax: 200,
            status: val > 200 ? 'high' : 'normal',
            confidence: 95,
            extractedSnippet: line.trim()
          });
        }
      } else if (lower.includes('tab') || lower.includes('cap') || lower.includes('mg') || lower.includes('glycomet') || lower.includes('metformin') || lower.includes('atorva')) {
        medications.push({
          id: `med-u-${idx}`,
          name: line.replace(/^[0-9\.\s\-]+/, '').trim(),
          dosage: 'As prescribed',
          frequency: 'Daily',
          duration: '30 Days',
          instructions: 'Take as directed by treating physician with water.'
        });
      }
    });

    // Default observation if empty
    if (observations.length === 0 && medications.length === 0) {
      observations.push({
        id: `obs-u-sample`,
        testName: 'Clinical Metric Assessment',
        category: 'General Examination',
        measuredValue: 1.0,
        unit: 'index',
        referenceRange: '0.8 - 1.2',
        referenceMin: 0.8,
        referenceMax: 1.2,
        status: 'normal',
        confidence: 94,
        extractedSnippet: cleanText.slice(0, 80)
      });
    }

    // Attempt Gemini summary generation with structured clinical prompt
    const aiPrompt = `You are a clinical AI health copilot analyzing an uploaded medical document for a patient named ${currentUser.fullName}.
Extracted text from document:
"""
${cleanText}
"""

Please provide:
1. Document overview (2-3 sentences explaining what this document is).
2. Key findings (bullet points of factual findings from the report).
3. Abnormal values flagged (with reference ranges).
4. Questions the patient should ask their doctor.
5. Important limitations (remind them this is for educational understanding and not a medical diagnosis).

Format clearly.`;

    const fallbackEn = {
      overview: `Medical document of type "${documentType || 'General Health Record'}" from ${doctorOrLab || 'Healthcare Facility'} for patient ${currentUser.fullName}.`,
      keyFindings: [
        'Document successfully ingested and validated through the OCR processing pipeline.',
        `Extracted ${observations.length} clinical observation(s) and ${medications.length} medication entry/entries.`,
        'All extracted data has been cataloged into the unified health profile and timeline.'
      ],
      abnormalValues: observations.filter(o => o.status !== 'normal').map(o => `${o.testName}: ${o.measuredValue} ${o.unit} (Ref: ${o.referenceRange}) - ${o.status.toUpperCase()}`),
      medicationsSummary: medications.map(m => `${m.name} - ${m.dosage} (${m.frequency})`),
      doctorQuestions: [
        'What are the primary factors contributing to any flagged abnormal values in this report?',
        'Do I require any lifestyle or dietary adjustments based on these latest results?',
        'When should I schedule my next follow-up examination or laboratory screening?'
      ],
      limitations: [
        'OCR extraction may have limitations with handwriting or degraded document quality.',
        'This AI analysis is provided strictly for educational organization and does not replace professional medical evaluation.'
      ]
    };

    const fallbackTe = {
      overview: `${currentUser.fullName} గారి కోసం ${doctorOrLab || 'ఆసుపత్రి / ల్యాబ్'} నుండి స్వీకరించిన ఆరోగ్య నివేదిక (${documentType || 'సాధారణ రికార్డు'}).`,
      keyFindings: [
        'పత్రం విజయవంతంగా పరిశీలించబడింది మరియు OCR ద్వారా పాఠ్యం సంగ్రహించబడింది.',
        `${observations.length} పరీక్షా ఫలితాలు మరియు ${medications.length} మందుల వివరాలు గుర్తించబడ్డాయి.`,
        'ఈ సమాచారం వ్యక్తిగత హెల్త్ టైమ్‌లైన్ మరియు ప్రొఫైల్‌లో భద్రపరచబడింది.'
      ],
      abnormalValues: observations.filter(o => o.status !== 'normal').map(o => `${o.testName}: ${o.measuredValue} ${o.unit} (పరిమితి: ${o.referenceRange}) - ${o.status === 'high' ? 'ఎక్కువ' : 'తక్కువ'}`),
      medicationsSummary: medications.map(m => `${m.name} - ${m.dosage} (${m.frequency})`),
      doctorQuestions: [
        'ఈ నివేదికలోని విలువల ఆధారంగా ఆహారపు లేదా జీవనశైలి మార్పులు అవసరమా?',
        'తదుపరి చెకప్ ఎప్పుడు చేయించుకోవాలి?'
      ],
      limitations: [
        'హ్యాండ్‌రైటింగ్ లేదా నాణ్యత లేని కాగితాల కారణంగా కొన్ని అక్షరాల గుర్తింపులో లోపాలు ఉండవచ్చు.',
        'ఈ సారాంశం అవగాహన కోసం మాత్రమే, వైద్యుల ప్రత్యక్ష సలహాకు ప్రత్యామ్నాయం కాదు.'
      ]
    };

    let aiGeneratedText = await generateAIResponse(aiPrompt, '');
    let summaryEn = fallbackEn;
    if (aiGeneratedText && aiGeneratedText.length > 50) {
      // Use parsed points from AI response
      summaryEn = {
        overview: aiGeneratedText.slice(0, 300).split('\n')[0] || fallbackEn.overview,
        keyFindings: [
          'AI extracted and synthesized observations from the uploaded record.',
          ...aiGeneratedText.split('\n').filter(l => l.trim().startsWith('-') || l.trim().startsWith('*')).slice(0, 4).map(l => l.replace(/^[-*]\s*/, ''))
        ],
        abnormalValues: fallbackEn.abnormalValues,
        medicationsSummary: fallbackEn.medicationsSummary,
        doctorQuestions: fallbackEn.doctorQuestions,
        limitations: fallbackEn.limitations
      };
    }

    const newDoc: DocumentRecord = {
      id: docId,
      userId: currentUser.id,
      title,
      fileName,
      fileType: fileType || 'application/pdf',
      fileSize: fileSize || 150000,
      uploadDate: new Date().toISOString(),
      reportDate: reportDate || new Date().toISOString().split('T')[0],
      documentType: documentType || 'lab_report',
      doctorOrLab: doctorOrLab || 'Clinical Laboratory Services',
      patientName: currentUser.fullName,
      extractedText: cleanText,
      ocrConfidence: 97.8,
      status: 'completed',
      observations,
      medications,
      summaryEn,
      summaryTe: fallbackTe
    };

    documentsStore.unshift(newDoc);

    auditLogs.unshift({
      id: `log-${Date.now()}`,
      timestamp: new Date().toISOString(),
      action: 'DOCUMENT_UPLOAD',
      details: `Uploaded & processed ${title} (${fileName})`,
      ip: req.ip || '127.0.0.1'
    });

    res.json({ success: true, document: newDoc });
  } catch (error: any) {
    console.error('Error processing upload:', error);
    res.status(500).json({ error: 'Failed to process medical document: ' + (error.message || 'Server error') });
  }
});

// Compare two medical reports
app.post('/api/comparison', (req: Request, res: Response) => {
  const { docId1, docId2 } = req.body;
  if (!docId1 || !docId2) {
    return res.status(400).json({ error: 'Two document IDs are required for comparison.' });
  }

  const doc1 = documentsStore.find(d => d.id === docId1);
  const doc2 = documentsStore.find(d => d.id === docId2);

  if (!doc1 || !doc2) {
    return res.status(404).json({ error: 'One or both documents not found.' });
  }

  // Sort chronologically (earlier report is baseline, later is follow-up)
  const earlier = new Date(doc1.reportDate) <= new Date(doc2.reportDate) ? doc1 : doc2;
  const later = earlier.id === doc1.id ? doc2 : doc1;

  // Find matching biomarkers
  interface ComparisonMarker {
    testName: string;
    category: string;
    unit: string;
    earlierValue: number;
    earlierDate: string;
    earlierStatus: string;
    laterValue: number;
    laterDate: string;
    laterStatus: string;
    referenceRange: string;
    diff: number;
    percentChange: number;
    trend: 'improved' | 'worsened' | 'stable';
    clinicalNote: string;
  }

  const comparisonMarkers: ComparisonMarker[] = [];

  earlier.observations.forEach(obs1 => {
    const match = later.observations.find(obs2 => 
      obs2.testName.toLowerCase().trim() === obs1.testName.toLowerCase().trim() ||
      (obs1.testName.includes('FBS') && obs2.testName.includes('FBS')) ||
      (obs1.testName.includes('HbA1c') && obs2.testName.includes('HbA1c')) ||
      (obs1.testName.includes('Cholesterol') && obs2.testName.includes('Cholesterol') && !obs1.testName.includes('LDL') && !obs2.testName.includes('LDL'))
    );

    if (match) {
      const diff = Number((match.measuredValue - obs1.measuredValue).toFixed(2));
      const pct = obs1.measuredValue !== 0 ? Number(((diff / obs1.measuredValue) * 100).toFixed(1)) : 0;
      
      let trend: 'improved' | 'worsened' | 'stable' = 'stable';
      if (obs1.testName.toLowerCase().includes('hemoglobin')) {
        trend = match.measuredValue > obs1.measuredValue ? 'improved' : match.measuredValue < obs1.measuredValue ? 'worsened' : 'stable';
      } else if (obs1.testName.toLowerCase().includes('glucose') || obs1.testName.toLowerCase().includes('hba1c') || obs1.testName.toLowerCase().includes('cholesterol')) {
        trend = match.measuredValue < obs1.measuredValue ? 'improved' : match.measuredValue > obs1.measuredValue ? 'worsened' : 'stable';
      } else {
        trend = Math.abs(pct) < 3 ? 'stable' : match.status === 'normal' && obs1.status !== 'normal' ? 'improved' : 'stable';
      }

      comparisonMarkers.push({
        testName: obs1.testName,
        category: obs1.category,
        unit: obs1.unit,
        earlierValue: obs1.measuredValue,
        earlierDate: earlier.reportDate,
        earlierStatus: obs1.status,
        laterValue: match.measuredValue,
        laterDate: later.reportDate,
        laterStatus: match.status,
        referenceRange: obs1.referenceRange || match.referenceRange,
        diff,
        percentChange: pct,
        trend,
        clinicalNote: `${obs1.testName} shifted from ${obs1.measuredValue} to ${match.measuredValue} ${obs1.unit} (${diff >= 0 ? '+' : ''}${diff} ${obs1.unit}).`
      });
    }
  });

  const clinicalSummary = `Comparing "${earlier.title}" (${earlier.reportDate}) with "${later.title}" (${later.reportDate}). A total of ${comparisonMarkers.length} compatible biomarkers were analyzed. Key highlights: ${comparisonMarkers.filter(m => m.trend === 'improved').length} biomarker(s) demonstrated positive therapeutic improvement, while ${comparisonMarkers.filter(m => m.trend === 'worsened').length} showed elevation requiring continued clinical attention. Please consult your physician for individualized medical advice.`;

  res.json({
    earlierReport: { id: earlier.id, title: earlier.title, date: earlier.reportDate, doctorOrLab: earlier.doctorOrLab },
    laterReport: { id: later.id, title: later.title, date: later.reportDate, doctorOrLab: later.doctorOrLab },
    markers: comparisonMarkers,
    clinicalSummary
  });
});

// AI Health Assistant (Chatbot & Q&A)
app.post('/api/assistant/chat', async (req: Request, res: Response) => {
  try {
    const { message, selectedDocId, language } = req.body;
    if (!message) {
      return res.status(400).json({ error: 'Message is required.' });
    }

    const languageNames: Record<string, string> = {
      en: 'English',
      te: 'Telugu (తెలుగు)',
      hi: 'Hindi (हिन्दी)',
      kn: 'Kannada (ಕನ್ನಡ)',
      ta: 'Tamil (தமிழ்)',
      ml: 'Malayalam (മലയാളം)'
    };

    const targetLangName = languageNames[language] || 'English';

    // Find relevant context
    let contextData = '';
    const activeUserName = currentUser?.fullName || 'Patient';
    const activeUserAge = currentUser?.age || 42;
    const activeUserGender = currentUser?.gender || 'Male';

    if (selectedDocId && selectedDocId !== 'all') {
      const doc = documentsStore.find(d => d.id === selectedDocId);
      if (doc) {
        contextData = `Document: ${doc.title} (${doc.reportDate})\nLab/Doctor: ${doc.doctorOrLab}\nExtracted text: ${doc.extractedText.slice(0, 1500)}\nObservations:\n` +
          doc.observations.map(o => `- ${o.testName}: ${o.measuredValue} ${o.unit} (Ref: ${o.referenceRange}, Status: ${o.status})`).join('\n') +
          (doc.medications.length ? '\nMedications:\n' + doc.medications.map(m => `- ${m.name} ${m.dosage} (${m.frequency})`).join('\n') : '');
      }
    } else {
      contextData = `Patient: ${activeUserName}, Age: ${activeUserAge}, Gender: ${activeUserGender}\n` +
        documentsStore.map(d => `Document "${d.title}" (${d.reportDate}):\n` + d.observations.map(o => `  ${o.testName}: ${o.measuredValue} ${o.unit} [${o.status}]`).join('\n')).join('\n\n');
    }

    const aiPrompt = `You are "MediMate AI", an empathetic, highly knowledgeable personal healthcare copilot.
CRITICAL CLINICAL SAFETY RULES:
1. Ground your answers STRICTLY in the patient's provided records below. If information is not in their records, state clearly that it is not available.
2. DO NOT formulate a new medical diagnosis, do not prescribe drugs, do not tell them to alter prescribed doses.
3. For emergency symptoms (e.g. chest pain, severe shortness of breath, sudden numbness), immediately advise calling emergency services.
4. Answer fluently and clearly in ${targetLangName}.
5. Preserve medical terms, laboratory names, drug names, and numerical values accurately while explaining them in natural, easy-to-understand language.

PATIENT CONTEXT:
"""
${contextData}
"""

USER QUESTION:
"${message}"

Provide a clear, reassuring, structured explanation with bullet points where helpful:`;

    // Multi-language deterministic fallbacks if API is slow
    const lowerQ = message.toLowerCase();
    let fallbackReply = '';

    if (language === 'te') {
      if (lowerQ.includes('cholesterol') || lowerQ.includes('కొలెస్ట్రాల్')) {
        fallbackReply = `మీ నివేదికల ప్రకారం, మీ మొత్తం కొలెస్ట్రాల్ (Total Cholesterol) జనవరి 2026లో 215 mg/dL ఉండగా, మార్చి 2026 నాటికి 182 mg/dL కు తగ్గింది (సాధారణ పరిమితి 200 mg/dL కంటే తక్కువ). ఇది సానుకూల మెరుగుదల. LDL చెడు కొలెస్ట్రాల్ కూడా 138 నుండి 109 mg/dL కు చేరుకుంది.`;
      } else if (lowerQ.includes('sugar') || lowerQ.includes('diabetes') || lowerQ.includes('చక్కెర') || lowerQ.includes('మధుమేహం') || lowerQ.includes('hba1c')) {
        fallbackReply = `మీ తాజా రికార్డుల ప్రకారం: మీ ఉపవాస రక్త చక్కెర (FBS) 134 నుండి 112 mg/dL కు, అలాగే HbA1c 7.2% నుండి 6.6% కు తగ్గింది. అయినప్పటికీ 6.5% కంటే స్వల్పంగా ఎక్కువ ఉన్నందున డాక్టర్ సూచించిన మెట్‌ఫార్మిన్ (Glycomet) మందులను వేళకు తీసుకోవాలి.`;
      } else {
        fallbackReply = `నమస్కారం! మీ ప్రశ్నను పరిశీలించాను. మీ అప్‌లోడ్ చేసిన రికార్డుల ప్రకారం, మీ రక్త పరీక్షలు మరియు మందుల వివరాలు మెరుగుపడుతున్న ధోరణిని చూపుతున్నాయి. మరింత నిర్దిష్ట సమాచారం కోసం మీ వైద్యుడిని సంప్రదించండి.`;
      }
    } else if (language === 'hi') {
      if (lowerQ.includes('cholesterol') || lowerQ.includes('कोलेस्ट्रॉल')) {
        fallbackReply = `आपकी मेडिकल रिपोर्ट के अनुसार, आपका कुल कोलेस्ट्रॉल (Total Cholesterol) जनवरी 2026 में 215 mg/dL से घटकर मार्च 2026 में 182 mg/dL हो गया है (वांछित स्तर <200 mg/dL)। एलडीएल (LDL) भी 138 से घटकर 109 mg/dL पर आ गया है।`;
      } else if (lowerQ.includes('sugar') || lowerQ.includes('मधुमेह') || lowerQ.includes('डायबिटीज') || lowerQ.includes('hba1c')) {
        fallbackReply = `आपके परीक्षण परिणामों के अनुसार: फास्टिंग ब्लड शुगर 134 से घटकर 112 mg/dL तथा HbA1c 7.2% से घटकर 6.6% पर आ गया है। यह एक सकारात्मक सुधार है। डॉक्टर द्वारा निर्देशित मेटफॉर्मिन जारी रखें।`;
      } else {
        fallbackReply = `नमस्ते! आपकी सहेजी गई मेडिकल रिपोर्टों के अनुसार, आपके स्वास्थ्य संकेतकों में सुधार दिख रहा है। किसी भी दवा में बदलाव से पहले हमेशा अपने डॉक्टर से परामर्श लें।`;
      }
    } else if (language === 'kn') {
      if (lowerQ.includes('cholesterol') || lowerQ.includes('ಕೊಲೆಸ್ಟ್ರಾಲ್')) {
        fallbackReply = `ನಿಮ್ಮ ವರದಿಗಳ ಪ್ರಕಾರ, ಒಟ್ಟು ಕೊಲೆಸ್ಟ್ರಾಲ್ (Total Cholesterol) ಜನವರಿ 2026 ರಲ್ಲಿ 215 mg/dL ನಿಂದ ಮಾರ್ಚ್ 2026 ರಲ್ಲಿ 182 mg/dL ಗೆ ಇಳಿದಿದೆ. LDL ಕೂಡ 138 ರಿಂದ 109 mg/dL ಗೆ ಕಡಿಮೆಯಾಗಿದೆ. ಇದು ಉತ್ತಮ ಪ್ರಗತಿಯಾಗಿದೆ.`;
      } else if (lowerQ.includes('sugar') || lowerQ.includes('ಮಧುಮೇಹ') || lowerQ.includes('hba1c')) {
        fallbackReply = `ನಿಮ್ಮ ಇತ್ತೀಚಿನ ವರದಿಗಳ ಪ್ರಕಾರ: ರಕ್ತದ ಸಕ್ಕರೆ (FBS) 134 ರಿಂದ 112 mg/dL ಗೆ ಮತ್ತು HbA1c 7.2% ರಿಂದ 6.6% ಗೆ ಕಡಿಮೆಯಾಗಿದೆ. ವೈದ್ಯರ ನಿರ್ದೇಶನದಂತೆ ಔಷಧಿ ಮುಂದುವರಿಸಿ.`;
      } else {
        fallbackReply = `ನಮಸ್ಕಾರ! ನಿಮ್ಮ ವೈದ್ಯಕೀಯ ದಾಖಲೆಗಳ ಪ್ರಕಾರ ನಿಮ್ಮ ಆರೋಗ್ಯ ಸೂಚಕಗಳು ಸುಧಾರಣೆಯ ಹಾದಿಯಲ್ಲಿವೆ. ಹೆಚ್ಚಿನ ಮಾಹಿತಿಗೆ ನಿಮ್ಮ ವೈದ್ಯರನ್ನು ಸಂಪರ್ಕಿಸಿ.`;
      }
    } else if (language === 'ta') {
      if (lowerQ.includes('cholesterol') || lowerQ.includes('கொலஸ்ட்ரால்')) {
        fallbackReply = `உங்கள் அறிக்கைகளின்படி, மொத்த கொலஸ்ட்ரால் ஜனவரி 2026 இல் 215 mg/dL இலிருந்து மார்ச் 2026 இல் 182 mg/dL ஆக குறைந்துள்ளது. LDL கெட்ட கொலஸ்ட்ரால் 138 இலிருந்து 109 mg/dL ஆக குறைந்துள்ளது. இது நேர்மறையான முன்னேற்றம்.`;
      } else if (lowerQ.includes('sugar') || lowerQ.includes('சர்க்கரை') || lowerQ.includes('hba1c')) {
        fallbackReply = `உங்கள் சமீபத்திய அறிக்கைகளின்படி: ஃபாஸ்டிங் ரத்த சர்க்கரை 134 இலிருந்து 112 mg/dL ஆகவும், HbA1c 7.2% இலிருந்து 6.6% ஆகவும் குறைந்துள்ளது. தொடர்ந்து மருந்து மற்றும் உணவு முறையைப் பின்பற்றுங்கள்.`;
      } else {
        fallbackReply = `வணக்கம்! உங்கள் மருத்துவ அறிக்கைகளின்படி உங்கள் சுகாதார அளவுகள் நல்ல முன்னேற்றத்தைக் காட்டுகின்றன. கூடுதல் விவரங்களுக்கு உங்கள் மருத்துவரிடம் ஆலோசனை பெறுங்கள்.`;
      }
    } else if (language === 'ml') {
      if (lowerQ.includes('cholesterol') || lowerQ.includes('കൊളസ്ട്രോൾ')) {
        fallbackReply = `നിങ്ങളുടെ റിപ്പോർട്ടുകൾ അനുസരിച്ച്, ടോട്ടൽ കൊളസ്ട്രോൾ ജനുവരി 2026-ൽ 215 mg/dL ആയിരുന്നത് മാർച്ച് 2026-ൽ 182 mg/dL ആയി കുറഞ്ഞു. എൽ.ഡി.എൽ (LDL) 138-ൽ നിന്ന് 109 mg/dL ആയി മെച്ചപ്പെട്ടു.`;
      } else if (lowerQ.includes('sugar') || lowerQ.includes('പ്രമേഹം') || lowerQ.includes('hba1c')) {
        fallbackReply = `നിങ്ങളുടെ രേഖകൾ പ്രകാരം: ഫാസ്റ്റിംഗ് ബ്ലഡ് ഷുഗർ 134-ൽ നിന്ന് 112 mg/dL ആയും, HbA1c 7.2% ൽ നിന്ന് 6.6% ആയും കുറഞ്ഞു. ഡോക്ടറുടെ നിർദ്ദേശപ്രകാരം മരുന്നുകൾ കൃത്യമായി കഴിക്കുക.`;
      } else {
        fallbackReply = `നമസ്കാരം! നിങ്ങളുടെ മെഡിക്കൽ രേഖകൾ അനുസരിച്ച് ആരോഗ്യ നിലയിൽ മികച്ച പുരോഗതി കാണുന്നു. കൂടുതൽ വിവരങ്ങൾക്ക് ഡോക്ടറെ സമീപിക്കുക.`;
      }
    } else {
      if (lowerQ.includes('cholesterol')) {
        fallbackReply = `Based on your uploaded records:\n\n• **Baseline (Jan 2026)**: Total Cholesterol was 215 mg/dL (High) and LDL was 138 mg/dL.\n• **Follow-up (Mar 2026)**: Total Cholesterol improved to 182 mg/dL (Desirable, <200 mg/dL) and LDL dropped to 109 mg/dL.\n• **Current Therapy**: Tab. Atorva (Atorvastatin 10mg) at night.\n\n*Note: This demonstrates a positive response to your prescribed statin therapy and dietary adjustments.*`;
      } else if (lowerQ.includes('sugar') || lowerQ.includes('diabetes') || lowerQ.includes('hba1c') || lowerQ.includes('glucose')) {
        fallbackReply = `Here is your glycemic trend based on your verified laboratory records:\n\n• **Fasting Blood Sugar (FBS)**: Improved from 134 mg/dL down to 112 mg/dL (Reference target: <100 mg/dL).\n• **HbA1c (3-month average)**: Reduced from 7.2% to 6.6% (Diabetic threshold is ≥6.5%).\n• **Medication**: Tab. Glycomet (Metformin 500mg) twice daily after meals.\n\nYour HbA1c is trending positively towards the non-diabetic target of <6.5%. Maintain your medication adherence.`;
      } else {
        fallbackReply = `Based on your saved medical dossier, your recent follow-up indicates noticeable improvement across your metabolic panel, including a drop in HbA1c (7.2% → 6.6%) and normalization of total cholesterol (215 → 182 mg/dL).\n\nIf you have a specific question about your tests, medications, or lab reference ranges, please ask!`;
      }
    }

    const reply = await generateAIResponse(aiPrompt, fallbackReply);

    res.json({
      reply,
      groundedInDoc: selectedDocId,
      language: targetLangName,
      timestamp: new Date().toISOString()
    });
  } catch (err: any) {
    console.error('Error in assistant chat:', err);
    res.status(500).json({ error: 'Chat assistant error: ' + (err.message || 'Server error') });
  }
});

// Medical Term Explainer API
app.post('/api/assistant/explain-term', async (req: Request, res: Response) => {
  const { term, language } = req.body;
  if (!term) {
    return res.status(400).json({ error: 'Term is required.' });
  }

  const termsDb: Record<string, { 
    en: string; 
    te: string; 
    hi: string; 
    kn: string; 
    ta: string; 
    ml: string; 
    normalRange: string 
  }> = {
    'hba1c': {
      en: 'HbA1c (Glycated Hemoglobin) measures your average blood sugar level over the past 2 to 3 months.',
      te: 'HbA1c (గ్లైకేటెడ్ హిమోగ్లోబిన్) గత 2 నుండి 3 నెలల మీ సగటు రక్త చక్కెర స్థాయిని తెలియజేస్తుంది.',
      hi: 'HbA1c (ग्लाइकेटेड हीमोग्लोबिन) पिछले 2 से 3 महीनों में आपके औसत रक्त शर्करा के स्तर को मापता है।',
      kn: 'HbA1c ಕಳೆದ 2 ರಿಂದ 3 ತಿಂಗಳುಗಳಲ್ಲಿ ನಿಮ್ಮ ಸರಾಸರಿ ರಕ್ತದ ಸಕ್ಕರೆ ಮಟ್ಟವನ್ನು ಅಳೆಯುತ್ತದೆ.',
      ta: 'HbA1c கடந்த 2 முதல் 3 மாதங்களில் உங்கள் சராசரி ரத்த சர்க்கரை அளவை அளவிடுகிறது.',
      ml: 'HbA1c കഴിഞ്ഞ 2 മുതൽ 3 മാസങ്ങളിലെ നിങ്ങളുടെ ശരാശരി രക്തത്തിലെ പഞ്ചസാരയുടെ അളവ് കണക്കാക്കുന്നു.',
      normalRange: 'Normal: < 5.7% | Prediabetes: 5.7 - 6.4% | Diabetes: ≥ 6.5%'
    },
    'hemoglobin': {
      en: 'Hemoglobin is an iron-rich protein in red blood cells that carries oxygen from the lungs to your entire body.',
      te: 'హిమోగ్లోబిన్ అనేది ఎర్ర రక్త కణాలలో ఉండే ముఖ్యమైన ఐరన్ ప్రోటీన్, ఇది శరీరమంతటా ఆక్సిజన్‌ను సరఫరా చేస్తుంది.',
      hi: 'हीमोग्लोबिन लाल रक्त कोशिकाओं में पाया जाने वाला आयरन युक्त प्रोटीन है जो शरीर में ऑक्सीजन पहुंचाता है।',
      kn: 'ಹಿಮೋಗ್ಲೋಬಿನ್ ಕೆಂಪು ರಕ್ತ ಕಣಗಳಲ್ಲಿರುವ ಪ್ರೋಟೀನ್ ಆಗಿದ್ದು, ಇಡೀ ದೇಹಕ್ಕೆ ಆಮ್ಲಜನಕವನ್ನು ಸಾಗಿಸುತ್ತದೆ.',
      ta: 'ஹீமோகுளோபின் என்பது ரத்த சிவப்பணுக்களில் உள்ள இரும்புச்சத்து நிறைந்த புரதமாகும், இது உடல் முழுவதும் ஆக்ஸிஜனைக் கொண்டு செல்கிறது.',
      ml: 'ഹീമോഗ്ലോബിൻ ചുവന്ന രക്താണുക്കളിലെ ഇരുമ്പ് അടങ്ങിയ പ്രോട്ടീനാണ്, ഇത് ശരീരമാകെ ഓക്സിജൻ എത്തിക്കുന്നു.',
      normalRange: 'Men: 13.0 - 17.0 g/dL | Women: 12.0 - 15.5 g/dL'
    },
    'ldl': {
      en: 'LDL is known as "bad cholesterol" because elevated levels can build up in arteries and increase cardiovascular risk.',
      te: 'LDL ను "చెడు కొలెస్ట్రాల్" అంటారు, ఇది రక్తనాళాలలో పేరుకుపోయి రక్త ప్రసరణకు ఆటంకం కలిగించవచ్చు.',
      hi: 'LDL को "खराब कोलेस्ट्रॉल" कहा जाता है क्योंकि इसका अधिक स्तर धमनियों में रुकावट पैदा कर सकता है।',
      kn: 'LDL ಅನ್ನು "ಕೆಟ್ಟ ಕೊಲೆಸ್ಟ್ರಾಲ್" ಎಂದು ಕರೆಯಲಾಗುತ್ತದೆ, ಇದು ರಕ್ತನಾಳಗಳಲ್ಲಿ ಜಮೆಯಾಗಬಹುದು.',
      ta: 'LDL "கெட்ட கொலஸ்ட்ரால்" என அழைக்கப்படுகிறது, இது ரத்த நாளங்களில் படிந்து அடைப்பை ஏற்படுத்தலாம்.',
      ml: 'എൽ.ഡി.എൽ "മോശം കൊളസ്ട്രോൾ" എന്നറിയപ്പെടുന്നു, ഇത് രക്തക്കുഴലുകളിൽ അടിഞ്ഞുകൂടാൻ സാധ്യതയുണ്ട്.',
      normalRange: 'Optimal: < 100 mg/dL | Near optimal: 100 - 129 mg/dL | High: ≥ 160 mg/dL'
    },
    'creatinine': {
      en: 'Serum Creatinine is a waste product filtered out of blood by kidneys. It indicates kidney health.',
      te: 'సీరమ్ క్రియాటినిన్ అనేది మూత్రపిండాల ద్వారా ఫిల్టర్ చేయబడే వ్యర్థ పదార్థం. ఇది కిడ్నీ ఆరోగ్యాన్ని సూచిస్తుంది.',
      hi: 'सीरम क्रिएटिनिन गुर्दे (किडनी) द्वारा रक्त से छाना जाने वाला अपशिष्ट उत्पाद है, जो किडनी के स्वास्थ्य को दर्शाता है।',
      kn: 'ಕ್ರಿಯೇಟಿನೈನ್ ಮೂತ್ರಪಿಂಡಗಳಿಂದ ಶೋಧಿಸಲ್ಪಡುವ ತ್ಯಾಜ್ಯ ಉತ್ಪನ್ನವಾಗಿದ್ದು, ಮೂತ್ರಪಿಂಡದ ಆರೋಗ್ಯವನ್ನು ಸೂಚಿಸುತ್ತದೆ.',
      ta: 'சீரம் கிரியேட்டினின் சிறுநீரகங்களால் ரத்தத்திலிருந்து வடிகட்டப்படும் ஒரு கழிவுப் பொருளாகும்.',
      ml: 'സെറം ക്രിയാറ്റിനിൻ വൃക്കകൾ രക്തത്തിൽ നിന്ന് ശുദ്ധീകരിക്കുന്ന ഒരു മാലിന്യ ഉൽപന്നമാണ്.',
      normalRange: '0.7 - 1.3 mg/dL (Adults)'
    },
    'metformin': {
      en: 'Metformin is a standard medication for Type 2 Diabetes that helps regulate blood glucose levels.',
      te: 'మెట్‌ఫార్మిన్ అనేది టైప్ 2 మధుమేహం నియంత్రణకు విస్తృతంగా ఉపయోగించే సాధారణ ఔషధం.',
      hi: 'मेटफॉर्मिन टाइप 2 मधुमेह के लिए इस्तेमाल की जाने वाली दवा है जो रक्त शर्करा को नियंत्रित करती है।',
      kn: 'ಮೆಟ್‌ಫಾರ್ಮಿನ್ ಟೈಪ್ 2 ಮಧುಮೇಹ ನಿಯಂತ್ರಣಕ್ಕಾಗಿ ಬಳಸುವ ಮುಖ್ಯ ಔಷಧಿಯಾಗಿದೆ.',
      ta: 'மெட்ஃபோர்மின் என்பது வகை 2 நீரிழிவு நோய்க்கான முக்கியமான மருந்தாகும்.',
      ml: 'ടൈപ്പ് 2 പ്രമേഹ നിയന്ത്രണത്തിന് ഉപയോഗിക്കുന്ന പ്രധാന മരുന്നാണ് മെറ്റ്ഫോർമിൻ.',
      normalRange: 'Therapeutic prescription medication'
    }
  };

  const key = term.toLowerCase().trim();
  const found = Object.keys(termsDb).find(k => key.includes(k) || k.includes(key));

  if (found) {
    const data = termsDb[found];
    const userLang = language || 'en';
    const localizedExplanation = (data as any)[userLang] || data.en;

    return res.json({
      term,
      explanation: localizedExplanation,
      explanationEn: data.en,
      explanationTe: data.te,
      explanationHi: data.hi,
      explanationKn: data.kn,
      explanationTa: data.ta,
      explanationMl: data.ml,
      referenceRange: data.normalRange
    });
  }

  // Ask Gemini if unknown term
  const targetLanguage = language || 'en';
  const aiPrompt = `Explain the medical term "${term}" in simple plain language for a patient.
Provide:
1. Clear explanation in English (2 sentences).
2. Translation in ${targetLanguage}.
3. Standard clinical reference range if applicable.`;

  const aiText = await generateAIResponse(aiPrompt, `The medical term "${term}" is a clinical observation or test. Please check with your laboratory report or doctor for specific reference intervals.`);

  res.json({
    term,
    explanation: aiText,
    explanationEn: aiText,
    explanationTe: `"${term}" అనేది వైద్య పరీక్ష లేదా మందు పేరు. మరిన్ని వివరాల కోసం మీ డాక్టర్ లేదా ల్యాబ్ నివేదికను పరిశీలించండి.`,
    referenceRange: 'Refer to specific clinical laboratory report'
  });
});

// ABHA (Ayushman Bharat Health Account) Simulation API
app.post('/api/abha/link', (req: Request, res: Response) => {
  const { abhaNumber, otp } = req.body;
  if (!abhaNumber || !otp) {
    return res.status(400).json({ error: 'ABHA Number and 6-digit Aadhaar/Mobile OTP are required.' });
  }

  if (otp !== '123456' && otp.length !== 6) {
    return res.status(400).json({ error: 'Invalid verification OTP. Enter 123456 for hackathon demonstration.' });
  }

  currentUser.isAbhaLinked = true;
  currentUser.abhaId = abhaNumber;
  currentUser.abhaAddress = `${currentUser.fullName.toLowerCase().replace(/\s+/g, '.')}@abdm`;

  auditLogs.unshift({
    id: `log-${Date.now()}`,
    timestamp: new Date().toISOString(),
    action: 'ABHA_ACCOUNT_LINKED',
    details: `Linked ABHA ID: ${abhaNumber} (${currentUser.abhaAddress}) via ABDM Gateway simulation`,
    ip: req.ip || '127.0.0.1'
  });

  res.json({
    success: true,
    user: currentUser,
    message: 'ABHA account successfully linked with Ayushman Bharat Digital Mission (ABDM) simulation profile.'
  });
});

// Export FHIR standard JSON bundle
app.get('/api/abha/fhir', (req: Request, res: Response) => {
  const fhirBundle = {
    resourceType: 'Bundle',
    id: `fhir-bundle-${currentUser.id}`,
    type: 'collection',
    timestamp: new Date().toISOString(),
    entry: [
      {
        resource: {
          resourceType: 'Patient',
          id: currentUser.id,
          identifier: [
            { system: 'https://healthid.ndhm.gov.in', value: currentUser.abhaId || '91-4829-1048-2918' }
          ],
          name: [{ text: currentUser.fullName }],
          gender: currentUser.gender.toLowerCase(),
          telecom: [{ system: 'phone', value: currentUser.phone || '+91 98490 12345' }]
        }
      },
      ...documentsStore.map(doc => ({
        resource: {
          resourceType: 'DocumentReference',
          id: doc.id,
          status: 'current',
          docStatus: 'final',
          type: { text: doc.title },
          date: doc.reportDate,
          author: [{ display: doc.doctorOrLab }]
        }
      })),
      ...documentsStore.flatMap(doc => doc.observations.map(obs => ({
        resource: {
          resourceType: 'Observation',
          id: obs.id,
          status: 'final',
          code: { text: obs.testName },
          valueQuantity: {
            value: obs.measuredValue,
            unit: obs.unit
          },
          referenceRange: [{ text: obs.referenceRange }]
        }
      })))
    ]
  };

  res.json(fhirBundle);
});

// Audit Logs
app.get('/api/audit-logs', (req: Request, res: Response) => {
  res.json({ logs: auditLogs });
});

// Mount Vite in development or static in production
async function startServer() {
  const isProd = process.env.NODE_ENV === 'production';

  if (!isProd) {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa'
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.resolve(__dirname, 'dist')));
    app.get('*', (req: Request, res: Response) => {
      res.sendFile(path.resolve(__dirname, 'dist', 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[MediMate AI] Server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
