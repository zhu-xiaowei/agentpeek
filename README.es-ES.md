

# 🔭 AgentPeek

Visualiza e interactúa con tus sesiones de [Claude Code](https://github.com/anthropics/claude-code) desde cualquier lugar: teléfono, tableta u otra computadora.

<p align="center">
  <img src="docs/assets/promo.avif" alt="AgentPeek" width="100%">
</p>

AgentPeek está construido sobre la infraestructura serverless de AWS (Lambda + DynamoDB + API Gateway) con cero intrusión en Claude Code. Todos los datos permanecen en tu propia cuenta de AWS: rápido, en tiempo real y siempre sincronizado.

## Inicio Rápido

### 1. Desplegar el Servidor

Requiere [AWS CLI](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html) con permisos para crear stacks de CloudFormation.

```bash
curl -fsSL https://raw.githubusercontent.com/zhu-xiaowei/agentpeek/main/server/install.sh | bash
```

Toma ~6-8 minutos. Muestra una **URL de inicio** y un código QR al finalizar con éxito. Admite las opciones `--region`, `--stack`, `--profile` (pásalas después de `bash -s --`).


### 2. Instalar el Bridge

Requiere [Node.js](https://nodejs.org/) >= 20.

1. Abre la **URL de inicio** en tu navegador (este es también el visor web)
2. Copia el comando de una línea **Install bridge** desde la página de configuración
3. Ejecútalo en la máquina donde se esté ejecutando Claude Code

### 3. Descargar la Aplicación

| iOS | Android | macOS | Windows |
|:---:|:---:|:---:|:---:|
| <img src="docs/assets/agentpeek_ios.png" width="120"> | <img src="docs/assets/agentpeek_android.png" width="120"> | <img src="docs/assets/macOS.png" width="120"> | <img src="docs/assets/windows.png" width="120"> |
| [TestFlight](https://testflight.apple.com/join/jJ4KQWjZ) | [AgentPeek.apk](https://github.com/zhu-xiaowei/agentpeek/releases/download/v0.2.0/AgentPeek.apk) | [AgentPeek.dmg](https://github.com/zhu-xiaowei/agentpeek/releases/download/v0.2.0/AgentPeek.dmg) | [AgentPeek.exe](https://github.com/zhu-xiaowei/agentpeek/releases/download/v0.2.0/AgentPeek.exe) |

Después de descargar la aplicación, escanea el código QR o introduce la URL de inicio para comenzar.

---

## Funcionalidades

- **Navegación multi-dispositivo** — enumera todos los dispositivos conectados, proyectos y sesiones de un vistazo
- **Vista de sesión en tiempo real** — sincronización ultrarrápida vía WebSocket mientras Claude Code está en ejecución
- **Estado de la sesión** — indicadores de ejecución (verde) / inactivo (amarillo) / detenido (gris)
- **Enviar mensajes** — escribe prompts directamente desde el teléfono o el escritorio, se entregan mediante un proceso de Claude Code en modo headless
- **Comandos slash** — autocompletado con `/` igual que en la terminal de Claude Code, listando tus comandos de usuario, proyecto y plugin
- **Enviar imágenes** — pega o selecciona fotos, se comprimen y suben a S3 para que las lea Claude Code
- **Soporte para Claude Agents** — supervisa e interactúa con las sesiones `claude agents` en segundo plano
- **Aprobación de permisos** — aprueba o deniega llamadas a herramientas (Bash, Edit, Write) de forma remota
- **Iniciar / detener sesiones** — lanza nuevas sesiones de Claude Code o Agent desde cualquier lugar
- **Renderizado de diff de código** — diffs en línea con resaltado de sintaxis para cambios en archivos
- **Visor de archivos del proyecto** — haz clic en un archivo para sincronizar y ver su código fuente, con resaltado y salto de línea; vista previa renderizada para HTML y Markdown
- **Soporte para Markdown** — renderizado completo de GFM para las respuestas de Claude
- **Nodos de ejecución** — bloques colapsables de `tool_use`/`tool_result` que muestran lo que hizo Claude
- **UI con tema oscuro** — interfaz limpia y optimizada para móviles que funciona en cualquier tamaño de pantalla

---

## Arquitectura

```
┌────────────────┐               ┌────────────────┐               ┌──────────────────┐
│     Bridge     │ ◀────WS─────▶ │     Server     │ ◀────WS─────▶ │     App/Web      │
│  (EC2, Mac)    │               │  (AWS Lambda)  │               │  (phone/desktop) │
└────────────────┘               └───────┬────────┘               └──────────────────┘
                                         │
                                         ▼
                                 ┌────────────────┐
                                 │   DynamoDB     │
                                 │(metadata + msg)│
                                 └────────────────┘
```

**Bridge** supervisa los archivos de sesión de Claude Code y envía mensajes vía WebSocket. **Server** retransmite mensajes en tiempo real a los clientes conectados y los almacena en caché en DynamoDB. **App** carga el historial de sesiones desde DDB al abrirlo (instantáneo, <100ms) para optimizar el rendimiento y la disponibilidad sin conexión, luego se suscribe vía WebSocket para actualizaciones en tiempo real.

---

## Licencia

MIT
