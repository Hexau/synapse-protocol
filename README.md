# @synapse/protocol

Contrato TypeScript compartido para el protocolo `a0-connector.v1` de
[Synapse](https://github.com/Hexau/team-agent-synapse) — tipos + un
cliente REST (`SynapseRestClient`), usados por `synapse-cli` y
`synapse-vscode` para no duplicar (ni desincronizar) cómo cada uno habla
con el backend.

Cada campo de cada interfaz está verificado contra el handler Python real
en `plugins/_a0_connector/api/v1/*.py` del backend — no son tipos
adivinados a partir de la documentación.

## Instalación

Este paquete no se publica a npm — se consume como un `.tgz` local
vendorizado en los repos que dependen de él (`synapse-cli/vendor/`,
`synapse-vscode/vendor/`). Ver
[docs/ECOSYSTEM-SETUP.md](https://github.com/Hexau/team-agent-synapse/blob/main/docs/ECOSYSTEM-SETUP.md#7-paquetes-compartidos-protocol-y-tokens)
en el repo principal para el flujo completo de "cambié esto, ahora
necesito propagarlo".

```bash
npm install
npm run compile
```

## Qué incluye

- **`types.ts`** — interfaces para cada endpoint (modelos, skills, agent
  profiles, chats, usage tracking, session-goal, multi-run, diff
  walkthrough, motor de políticas) más el protocolo WebSocket
  (`ConnectorEvent`, file ops, exec ops).
- **`restClient.ts`** — `SynapseRestClient`, un wrapper delgado sobre
  `fetch` con manejo de token de API, más `uploadFile` para adjuntos.
- **`wsClient.ts`** — cliente Socket.IO para el canal de eventos en vivo
  del chat.
- **`localOps.ts`** — operaciones de archivo locales (read/write/patch/
  list_tree) que usa `synapse-vscode` para responder a `connector_file_op`
  sin pasar por HTTP.

## Uso

```typescript
import { SynapseRestClient } from "@synapse/protocol";

const rc = new SynapseRestClient({
  serverUrl: "http://localhost:50080",
  apiToken: "...",
});

const { contexts } = await rc.listChats();
```

## Desarrollo

```bash
npm run watch   # tsc en modo watch
npm test        # compila y corre los tests con el runner nativo de Node
```

Después de cualquier cambio, repackear y reinstalar en los consumidores
(ver la sección de ambientación linkeada arriba) — `npm install` solo en
`synapse-cli`/`synapse-vscode` **no** recoge un `.tgz` actualizado con el
mismo nombre de archivo.
