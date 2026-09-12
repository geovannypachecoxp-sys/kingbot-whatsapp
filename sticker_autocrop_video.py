import sys
import os

def calculate_motion_crop(frame1_path, frame2_path):
    try:
        from PIL import Image, ImageChops
    except ImportError:
        print("[autocrop] Error: Pillow no está instalado.")
        return None

    try:
        img1 = Image.open(frame1_path).convert("L")
        img2 = Image.open(frame2_path).convert("L")
    except Exception as e:
        print(f"[autocrop] Error abriendo imágenes: {e}")
        return None

    if img1.size != img2.size:
        print("[autocrop] Error: Los fotogramas tienen diferente tamaño.")
        return None

    # Restar los fotogramas para encontrar el movimiento
    diff = ImageChops.difference(img1, img2)
    
    # Aplicar un umbral para eliminar el ruido de compresión de video (ej. diferencias muy pequeñas)
    threshold = 15
    diff = diff.point(lambda p: p > threshold and 255)
    
    # Encontrar el bounding box de las áreas que cambiaron
    bbox = diff.getbbox()
    
    if not bbox:
        print("[autocrop] No se detectó movimiento válido.")
        return None

    x1, y1, x2, y2 = bbox
    width = x2 - x1
    height = y2 - y1

    # Asegurarse de que el área no sea demasiado pequeña (probablemente solo ruido o un reloj cambiando)
    if width < 50 or height < 50:
        print(f"[autocrop] Movimiento ignorado por ser muy pequeño ({width}x{height}).")
        return None

    # Devolver los argumentos de crop para ffmpeg: w:h:x:y
    # Aseguramos que ancho y alto sean pares (ffmpeg lo prefiere para algunos codecs)
    if width % 2 != 0: width += 1
    if height % 2 != 0: height += 1

    return f"{width}:{height}:{x1}:{y1}"

if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("Uso: python sticker_autocrop_video.py <frame1.jpg> <frame2.jpg>")
        sys.exit(1)

    frame1 = sys.argv[1]
    frame2 = sys.argv[2]

    crop_args = calculate_motion_crop(frame1, frame2)
    if crop_args:
        print(f"CROP_PARAMS={crop_args}")
    else:
        print("CROP_PARAMS=NONE")
