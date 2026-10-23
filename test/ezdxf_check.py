"""Verificador independente (opcional): pip install ezdxf
Uso: python3 test/ezdxf_check.py arquivo.dxf [...]
Lê o DXF com o ezdxf (parser estrito), audita a estrutura e confere o sentido dos contornos
(externos CCW, furos CW) — contorno externo com área assinada negativa = peça ESPELHADA."""
import sys
import ezdxf

def area(p):
    return sum(p[i][0] * p[(i + 1) % len(p)][1] - p[(i + 1) % len(p)][0] * p[i][1] for i in range(len(p))) / 2

ok = True
for path in sys.argv[1:]:
    doc = ezdxf.readfile(path)
    audit = doc.audit()
    bad = 0
    for e in doc.modelspace():
        if e.dxftype() == 'POLYLINE' and e.dxf.layer in ('1_CORTE_PECAS', '1_PECA_IN_HOLE', '2_CORTE_FUROS'):
            pts = [(v.dxf.location.x, v.dxf.location.y) for v in e.vertices]
            if (e.dxf.layer == '2_CORTE_FUROS') != (area(pts) < 0):
                bad += 1
    print(f'{path}: versão {doc.dxfversion}, erros de auditoria={len(audit.errors)}, contornos com sentido invertido={bad}')
    ok &= (not audit.errors and bad == 0)
sys.exit(0 if ok else 1)
