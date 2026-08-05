

<p align="center">
  <br />
  <img src="assets/voca-logo.png" alt="Voca Logo" width="280" />
  <br /><br />
</p>

<h1 align="center">Voca — Tu Asistente Local de Clonación de Voz</h1>

<p align="center">
  Inglés | <a href="README_zh.md">简体中文</a> | <a href="README_zh-TW.md">繁體中文</a>
</p>

<p align="center">
  <a href="https://github.com/ZMXJJ/Voca/releases"><img src="https://img.shields.io/github/v/release/ZMXJJ/Voca?style=flat-square&label=Download" alt="Release" /></a>
  <a href="https://github.com/ZMXJJ/Voca/stargazers"><img src="https://img.shields.io/github/stars/ZMXJJ/Voca?style=flat-square" alt="Stars" /></a>
  <a href="https://github.com/ZMXJJ/Voca/issues"><img src="https://img.shields.io/github/issues/ZMXJJ/Voca?style=flat-square" alt="Issues" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-Apache_2.0-blue?style=flat-square" alt="License" /></a>
</p>

<p align="center">
  Una aplicación de escritorio con enfoque local para la clonación de voz. Descarga y utiliza: ¡la síntesis y clonación de voz de alta calidad se ejecutan íntegramente en tu equipo!
</p>

<p align="center">
  <br />
  <a href="https://github.com/ZMXJJ/Voca/releases/latest">
    <img src="https://img.shields.io/badge/Download_for_macOS-7c3aed?style=for-the-badge&logo=apple&logoColor=white" alt="Download for macOS" />
  </a>
  &nbsp;&nbsp;
  <a href="https://github.com/ZMXJJ/Voca/releases/latest">
    <img src="https://img.shields.io/badge/Download_for_Windows-0078D4?style=for-the-badge&logo=data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCI+PHBhdGggZmlsbD0id2hpdGUiIGQ9Ik0wIDMuNDk1bDkuODQtMS4zOFYxMS4wNUgwVjMuNDk1ek0wIDEyLjk1aDkuODR2OC45MzVMMCwyMC41MDVWMTIuOTV6TTEwLjk1IDEuOTc1TDI0IDB2MTEuMDVIMTAuOTVWMS45NzV6TTEwLjk1IDEyLjk1SDI0VjI0bC0xMy4wNS0xLjk3NVYxMi45NXoiLz48L3N2Zz4=&logoColor=white" alt="Download for Windows" />
  </a>
  <br />
  <sub>La inferencia en Windows requiere una GPU NVIDIA</sub>
</p>

---

## Capturas

<p align="center">
  <img src="assets/screenshot-workspace-en.png" alt="Voice Studio" width="48%" />
  &nbsp;
  <img src="assets/screenshot-settings-en.png" alt="Settings" width="48%" />
</p>

## ísticas destacadas

- **Totalmente offline** — Tras descargar el modelo, toda la inferencia se ejecuta localmente sin necesidad de red ni preocupaciones por la privacidad
- **Sin configuración** — En el primer inicio, detecta automáticamente el entorno, descarga el entorno de ejecución, descarga y precalienta el modelo
- **Clonación de voz de alta calidad** — Impulsado por el motor VoxCPM, que soporta síntesis de voz y clonación bilingüe (chino e inglés)
- **Control fino** — Escala de guía CFG ajustable, pasos de inferencia, semilla, normalización de texto, reducción de ruido posterior y más
- **Modo de clonación extrema** — Utiliza la transcripción de audio de referencia para mejorar aún más la fidelidad de la voz
- **ASR integrado** — Transcribe automáticamente el audio de referencia con SenseVoice Small (ONNX Runtime en CPU), con soporte para edición manual
- **Fuentes duales de modelos** — Descarga modelos desde Hugging Face o ModelScope, con recomendación automática de la fuente óptima
- **Interfaz trilingüe** — Interfaz en chino tradicional, chino simplificado e inglés

## Índice

- [Primeros pasos](#getting-started)
- [Funcionalidades](#features)
- [Stack tecnológico](#tech-stack)
- [Hoja de ruta](#roadmap)
- [Contribuir](#contributing)
- [Limitaciones conocidas](#known-limitations)
- [Agradecimientos](#acknowledgments)
- [Licencia](#license)

## Primeros pasos

### Requisitos del sistema

| Elemento | macOS | Windows |
|------|-------|---------|
| Versión | macOS 14.0 (Sonoma) o posterior | Windows 10 22H2 / Windows 11 (x86_64) |
| Chip | Apple Silicon (M1/M2/M3/M4) | Intel/AMD x86_64 con GPU NVIDIA |
| Espacio en disco | ~6 GB (app + modelos) | ~11 GB (app + modelos + entorno de ejecución CUDA; descarga del entorno ~2.5 GB) |
| Backend de inferencia | MPS (Apple Silicon) por defecto | CUDA (requiere GPU NVIDIA) |

### Instalación

**macOS**

1. Ve a la página de [Releases](https://github.com/ZMXJJ/Voca/releases) y descarga el último archivo `.dmg`
2. Abre el DMG y arrastra Voca a la carpeta Aplicaciones
3. En el primer inicio, sigue la guía de configuración para descargar los modelos y comenzar a usar la aplicación

**Windows**

1. Ve a la página de [Releases](https://github.com/ZMXJJ/Voca/releases) y descarga el último `Voca-x.y.z-x64-setup.exe`
2. Ejecuta el instalador (instalación para el usuario, no se requieren permisos de administrador) y abre Voca desde el menú Inicio
3. En el primer inicio, la guía de configuración descargará automáticamente el entorno de ejecución CUDA (~2.5 GB de descarga con transferencia reanudable)

> **Nota:** La instalación del entorno de ejecución CUDA requiere aproximadamente **5 GB** de espacio en disco libre adicional. Asegúrate de tener suficiente8espacio disponible antes de continuar.

> **Sobre la firma y notarización de la aplicación**
>
> Voca está firmada con un Apple Developer ID y ha sido 8notarizada con éxito por Apple, por lo que es seguro ejecutarla en macOS.
>
> Si aún recibes una advertencia de Gatekeeper en el primer inicio (p. ej., "Voca" no se puede abrir, "Voca está dañado y no se puede abrir" o "no se puede verificar el desarrollador"), suele deberse a que macOS ha adjuntado un atributo de cuarentena a los archivos descargados a través del navegador. Puedes eliminar la  de cuarentena ejecutando el siguiente comando en Terminal:
>
> ```bash
> sudo xattr -dr com.apple.quarantine /Applications/Voca.app
> ```
>
> Luego vuelve a abrir Voca. Alternativamente, abre **Ajustes del sistema → Privacidad y seguridad** y haz clic en **Abrir de todas formas**.

### Primer inicio

Voca incluye un flujo completo de bienvenida:

**Verificación del entorno** → **Descarga del entorno de ejecución** → **Descarga y verificación del modelo** → **Precalentamiento del modelo** → **Listo para usar**

Simplemente sigue las instrucciones en pantalla: no se necesita configuración manual.

## Funcionalidades

### Espacio de trabajo para generación de voz

Introduce texto, selecciona un modelo y una voz, y genera voz de alta calidad con un solo clic. Admite la gestión de tareas en cola para enviar múltiples solicitudes de generación simultáneamente.

Parámetros de generación ajustables:

| Parámetro | Descripción |
|-----------|-------------|
| Escala CFG | Controla la fuerza de la guía de generación |
| Pasos de inferencia | Equilibrio entre calidad y velocidad |
| Semilla | Fija la semilla para resultados reproducibles o aleatorízala |
| Normalización de texto | Maneja automáticamente números, abreviaturas, etc. |
| Reducción de ruido posterior | Elimina el ruido de fondo después de la generación |
| Modo de clonación extrema | Utiliza la transcripción de audio de referencia para mejorar la fidelidad de la clonación de voz |

### Biblioteca de voces

Gestiona voces predefinidas y personalizadas. Al crear voces personalizadas, sube el audio de referencia y el reconocedor ONNX SenseVoice integrado transcribirá automáticamente el texto, con soporte para edición manual.

### Historial de generación

Consulta el estado de todas las tareas (en cola / generando / completada / fallida / cancelada). Las tareas completadas se pueden reproducir y exportar como archivos de audio.

### Gestión de modelos

Catálogo de modelos integrado con soporte para descargar desde Hugging Face o ModelScope, con recomendación automática de la fuente óptima según tu red. Gestiona modelos TTS y modelos auxiliares (ASR, mejora de audio).

### Comprobación de actualizaciones en la app

Verifica nuevas versiones en Ajustes. Cuando haya una 8disponible, la app abre la página de Release correspondiente para descargarla.

## Stack tecnológico

| Capa | Tecnología |
|-------|-----------|
| Framework de escritorio | Tauri 2 (Rust) |
| Frontend | React 19 + TypeScript + Vite |
| Servicio de inferencia | Python (FastAPI + Uvicorn) sidecar |
| Motor de voz | VoxCPM |
| Entorno de ejecución | Python 3.11+ |
| Plataforma | macOS 14.0+ (Apple Silicon) |

## Hoja de ruta

> Direcciones de desarrollo futuras. Las prioridades pueden cambiar según los comentarios de la comunidad.

- [x] **Backend de inferencia más ligero** — ASR migrado de PyTorch/FunASR a ONNX Runtime (`iic/SenseVoiceSmall-onnx`, INT8), reduciendo significativamente el tamaño de la app y la descarga de modelos
- [ ] **Soporte para modelos cuantizados** — Inferencia INT8 y otras cuantizaciones para reducir el uso de memoria y disco
- [ ] **Mayores capacidades TTS** — Soporte para más modelos TTS y características de síntesis de voz expandidas
- [ ] **Huella más ligera en Windows** — Reducir el uso de disco y memoria en Windows para una experiencia más ligera
- [x] Soporte para Windows (x86_64, instalador NSIS, actualización CUDA opcional)

¿Tienes ideas o sugerencias? Háznoslo saber a través de [Issues](https://github.com/ZMXJJ/Voca/issues).

## Contribuir

> **Nota:** Voca se encuentra aún en sus primeras etapas. La experiencia de ingeniería (flujo de construcción, documentación para desarrolladores, estructura del código, etc.) puede no estar completamente 8pul8aún. Si te encuentras con algún problema al usar o desarrollar, nos encantaría que abras un Issue o contribuyas directamente — trabajemos para mejorarlo juntos.

Formas de participar:

- Enviar informes de errores o solicitudes de características → [Issues](https://github.com/ZMXJJ/Voca/issues)
- Enviar mejoras de código → Pull Request
- Mejorar la documentación o traducciones

## Limitaciones conocidas

- Se ejecuta en macOS (Apple Silicon) y Windows x86_64; el soporte para Linux no está 8aún planeado
- El primer inicio requiere conexión a Internet para descargar modelos (~1–2 GB); una vez descargados, funciona completamente offline
- La calidad de la clonación de voz depende en gran medida de la calidad del audio de referencia — se recomienda audio limpio sin ruido de fondo

## Agradecimientos

- [VoxCPM](https://github.com/OpenBMB/VoxCPM) — Motor de síntesis de voz
- [Tauri](https://tauri.app/) — Framework de aplicaciones de escritorio
- [SenseVoice](https://github.com/FunAudioLLM/SenseVoice) — Modelo de reconocimiento de voz
- Modelos: [Claude Opus 4.6](https://www.anthropic.com/) y [GPT-5.4](https://openai.com/)

## Licencia

Este proyecto está licenciado bajo la [Licencia Apache 2.0](LICENSE).

---

<p align="center">
  <a href="https://star-history.com/#ZMXJJ/Voca&Date">
    <img src="https://api.star-history.com/svg?repos=ZMXJJ/Voca&type=Date" width="600" alt="Star History" />
  </a>
</p>
