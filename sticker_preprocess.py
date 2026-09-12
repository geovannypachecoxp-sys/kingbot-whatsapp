#!/usr/bin/env python3
"""
sticker_preprocess.py — Preprocesador de imágenes para stickers de WhatsApp.
Remueve el fondo usando rembg (o fallback con Pillow) y auto-crop al contenido.

Uso:
    python3 sticker_preprocess.py <input_path> <output_path>
    python3 sticker_preprocess.py --test

Salida: imagen PNG con fondo transparente, recortada al bounding box del sujeto.
"""

import sys
import os

def has_rembg():
    try:
        import rembg
        return True
    except ImportError:
        return False

def has_pillow():
    try:
        from PIL import Image
        return True
    except ImportError:
        return False

def remove_bg_rembg(input_path, output_path):
    """Remueve fondo con rembg (modelo u2net)."""
    from rembg import remove
    from PIL import Image
    import io

    with open(input_path, 'rb') as f:
        input_data = f.read()

    print("[sticker_preprocess] Usando rembg para remover fondo...")
    output_data = remove(input_data)

    img = Image.open(io.BytesIO(output_data)).convert("RGBA")

    # Auto-crop al bounding box del contenido no-transparente
    bbox = img.getbbox()
    if bbox:
        img = img.crop(bbox)
        print(f"[sticker_preprocess] Auto-crop aplicado: {bbox}")
    else:
        print("[sticker_preprocess] No se detectó contenido para crop (imagen vacía?)")

    img.save(output_path, "PNG")
    print(f"[sticker_preprocess] Guardado: {output_path} ({img.size[0]}x{img.size[1]})")
    return True

def remove_bg_fallback(input_path, output_path):
    """Fallback: detecta bordes con Pillow y recorta al área principal de contraste."""
    from PIL import Image, ImageFilter

    print("[sticker_preprocess] Usando fallback Pillow (sin rembg)...")
    img = Image.open(input_path).convert("RGBA")
    width, height = img.size

    # Convertir a escala de grises para detectar bordes
    gray = img.convert("L")

    # Aplicar detección de bordes
    edges = gray.filter(ImageFilter.FIND_EDGES)

    # Binarizar: pixel > umbral = contenido
    threshold = 30
    binary = edges.point(lambda p: 255 if p > threshold else 0, mode='1')

    # Obtener bounding box del contenido detectado
    bbox = binary.getbbox()
    if bbox:
        # Expandir el bbox un 5% en cada dirección para no cortar contenido
        margin_x = int((bbox[2] - bbox[0]) * 0.05)
        margin_y = int((bbox[3] - bbox[1]) * 0.05)
        expanded = (
            max(0, bbox[0] - margin_x),
            max(0, bbox[1] - margin_y),
            min(width, bbox[2] + margin_x),
            min(height, bbox[3] + margin_y)
        )
        img = img.crop(expanded)
        print(f"[sticker_preprocess] Auto-crop fallback aplicado: {expanded}")
    else:
        print("[sticker_preprocess] No se detectó contenido, usando imagen completa")

    img.save(output_path, "PNG")
    print(f"[sticker_preprocess] Guardado (fallback): {output_path} ({img.size[0]}x{img.size[1]})")
    return True

def process(input_path, output_path):
    """Procesa la imagen: remueve fondo y auto-crop."""
    if not os.path.exists(input_path):
        print(f"[sticker_preprocess] ERROR: Archivo no encontrado: {input_path}")
        return False

    try:
        if has_rembg():
            return remove_bg_rembg(input_path, output_path)
        elif has_pillow():
            return remove_bg_fallback(input_path, output_path)
        else:
            print("[sticker_preprocess] ERROR: Ni rembg ni Pillow están instalados.")
            print("  Instala al menos uno:")
            print("    pip install rembg --break-system-packages")
            print("    pip install Pillow --break-system-packages")
            return False
    except Exception as e:
        print(f"[sticker_preprocess] ERROR en procesamiento: {e}")
        # Si rembg falla, intentar fallback
        if has_pillow():
            print("[sticker_preprocess] Intentando fallback con Pillow...")
            try:
                return remove_bg_fallback(input_path, output_path)
            except Exception as e2:
                print(f"[sticker_preprocess] ERROR en fallback: {e2}")
        return False

def run_test():
    """Test rápido para verificar que las dependencias funcionan."""
    print("=== sticker_preprocess.py — Test de dependencias ===")
    print(f"  Python: {sys.version}")
    print(f"  rembg:  {'✅ Instalado' if has_rembg() else '❌ No instalado (pip install rembg --break-system-packages)'}")
    print(f"  Pillow: {'✅ Instalado' if has_pillow() else '❌ No instalado (pip install Pillow --break-system-packages)'}")

    if has_pillow():
        from PIL import Image
        # Crear imagen de prueba y procesar
        test_in = '/tmp/sticker_test_in.png' if os.name != 'nt' else os.path.join(os.environ.get('TEMP', '.'), 'sticker_test_in.png')
        test_out = '/tmp/sticker_test_out.png' if os.name != 'nt' else os.path.join(os.environ.get('TEMP', '.'), 'sticker_test_out.png')

        img = Image.new("RGBA", (200, 200), (255, 255, 255, 255))
        # Dibujar un cuadrado rojo en el centro
        for x in range(50, 150):
            for y in range(50, 150):
                img.putpixel((x, y), (255, 0, 0, 255))
        img.save(test_in)

        result = process(test_in, test_out)
        if result and os.path.exists(test_out):
            out_img = Image.open(test_out)
            print(f"  Test: ✅ Procesado correctamente ({out_img.size[0]}x{out_img.size[1]})")
            os.unlink(test_in)
            os.unlink(test_out)
        else:
            print("  Test: ❌ Falló el procesamiento")
            if os.path.exists(test_in): os.unlink(test_in)
    else:
        print("  Test: ⚠️ No se puede ejecutar sin Pillow")

    print("===================================================")

if __name__ == '__main__':
    if len(sys.argv) == 2 and sys.argv[1] == '--test':
        run_test()
    elif len(sys.argv) == 3:
        success = process(sys.argv[1], sys.argv[2])
        sys.exit(0 if success else 1)
    else:
        print(f"Uso: {sys.argv[0]} <input_path> <output_path>")
        print(f"     {sys.argv[0]} --test")
        sys.exit(1)
