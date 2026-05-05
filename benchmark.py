import sys
import os
import json
import re
from types import ModuleType

# Comprehensive mocking to avoid ImportError
def mock_module(name, attrs=None):
    m = ModuleType(name)
    if attrs:
        for k, v in attrs.items():
            setattr(m, k, v)
    sys.modules[name] = m
    return m

genai = mock_module('google.generativeai')
genai.configure = lambda **kwargs: None
class MockModel:
    def __init__(self, *args, **kwargs): pass
    def generate_content(self, *args, **kwargs): pass
genai.GenerativeModel = MockModel

mock_module('google.api_core')
mock_module('google.api_core.exceptions', {'ResourceExhausted': Exception})
mock_module('config', {'GEMINI_API_KEYS': ['dummy']})

# Add path to import local modules
sys.path.append(os.path.join(os.getcwd(), 'data_extraction-main'))

from services.medical_extraction import MedicalExtractionService, CRITICAL_CARDIAC_ITEMS
from models.medical_entities import MedicalData

# 1. Mock Translation Mapping
styles_mapping = {
    'formal': {
        'Patient presents with severe chest pain and palpitations. History of hypertension.': 'Patient presents with severe chest pain and palpitations. History of hypertension.',
        'No shortness of breath reported. Negative for diabetes.': 'No shortness of breath reported. Negative for diabetes.',
        'Evidence of dizziness and fatigue. Denies asthma.': 'Evidence of dizziness and fatigue. Denies asthma.',
        'Patient has high blood pressure and obesity.': 'Patient has high blood pressure and obesity.'
    },
    'informal': {
        'My chest hurts a lot and my heart is racing. I have high blood pressure.': 'Patient has chest pain and palpitations. History of hypertension.',
        'I can breathe fine though. Not diabetic.': 'No shortness of breath. No diabetes.',
        'Feeling dizzy and very tired. No asthma.': 'Experiencing dizziness and fatigue. No asthma.',
        'I am quite overweight and have high BP.': 'Patient has obesity and hypertension.'
    },
    'singlish': {
        'Chest pain standard lah, heart also got jump jump. Got high blood pressure.': 'Chest pain and palpitations. History of hypertension.',
        'Breath okay one, no panting. Sugar no problem.': 'No shortness of breath. No diabetes.',
        'Blur blur and so tired. Asthma no have.': 'Dizziness and fatigue. No asthma.',
        'Body too gemuk and pressure high.': 'Obesity and hypertension.'
    },
    'noisy': {
        'CH3ST PA1N AND P4LP1TATIONS!! hbp present.': 'Chest pain and palpitations. Hypertension.',
        'no sob. sugar normal.': 'No shortness of breath. Diabetes negative.',
        'dizzy... very tired... no asthma.': 'Dizziness and fatigue. No asthma.',
        'v. overweight, high blood pressure.': 'Obesity, hypertension.'
    }
}

ground_truth = [
    {'symptoms': ['chest pain', 'palpitations'], 'risk_factors': ['hypertension']},
    {'symptoms': [], 'risk_factors': []},
    {'symptoms': ['dizziness', 'fatigue'], 'risk_factors': []},
    {'symptoms': [], 'risk_factors': ['obesity', 'hypertension']}
]

class MockMedicalExtractionService(MedicalExtractionService):
    def __init__(self):
        self.models = [MockModel()]
        self._model_cycle = iter(self.models)
    def extract(self, text: str) -> MedicalData:
        return self._fallback_extract(text)

def calculate_metrics(extracted, gt):
    ext_s = set(extracted.symptoms)
    gt_s = set(gt['symptoms'])
    tp_s = len(ext_s & gt_s)
    fp_s = len(ext_s - gt_s)
    fn_s = len(gt_s - ext_s)

    ext_r = set(extracted.risk_factors)
    gt_r = set(gt['risk_factors'])
    tp_r = len(ext_r & gt_r)
    fp_r = len(ext_r - gt_r)
    fn_r = len(gt_r - ext_r)

    expected_missing_s = set([s for s in CRITICAL_CARDIAC_ITEMS['symptoms'] if s not in gt['symptoms']])
    expected_missing_r = set([r for r in CRITICAL_CARDIAC_ITEMS['risk_factors'] if r not in gt['risk_factors']])
    
    ext_m_s = set(extracted.missing['symptoms'])
    ext_m_r = set(extracted.missing['risk_factors'])
    
    tp_m_s = len(ext_m_s & expected_missing_s)
    fp_m_s = len(ext_m_s - expected_missing_s)
    fn_m_s = len(expected_missing_s - ext_m_s)
    
    tp_m_r = len(ext_m_r & expected_missing_r)
    fp_m_r = len(ext_m_r - expected_missing_r)
    fn_m_r = len(expected_missing_r - ext_m_r)

    return {
        'tp': tp_s + tp_r + tp_m_s + tp_m_r,
        'fp': fp_s + fp_r + fp_m_s + fp_m_r,
        'fn': fn_s + fn_r + fn_m_s + fn_m_r
    }

def run_benchmark():
    service = MockMedicalExtractionService()
    results = {}

    for style, data in styles_mapping.items():
        total_metrics = {'tp': 0, 'fp': 0, 'fn': 0}
        for i, (raw_text, translated_text) in enumerate(data.items()):
            extracted = service.extract(translated_text)
            m = calculate_metrics(extracted, ground_truth[i])
            total_metrics['tp'] += m['tp']
            total_metrics['fp'] += m['fp']
            total_metrics['fn'] += m['fn']
        
        tp, fp, fn = total_metrics['tp'], total_metrics['fp'], total_metrics['fn']
        precision = tp / (tp + fp) if (tp + fp) > 0 else 0
        recall = tp / (tp + fn) if (tp + fn) > 0 else 0
        f1 = 2 * (precision * recall) / (precision + recall) if (precision + recall) > 0 else 0
        
        results[style] = {
            'precision': round(precision, 2),
            'recall': round(recall, 2),
            'f1': round(f1, 2)
        }

    print(json.dumps(results, indent=2))

if __name__ == "__main__":
    run_benchmark()
