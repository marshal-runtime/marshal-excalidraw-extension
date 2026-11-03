import { createExcalidrawCapabilityProvider } from "./capabilities.js";
import type { RuntimeExtensionActivation, RuntimeExtensionActivationContext, RuntimeExtensionModule } from "./extensionProtocol.js";
import { DEFAULT_ENDPOINT, HostedExcalidrawMcp } from "./mcpClient.js";
import { SceneStore } from "./scene.js";
import { createDiagramUiApplication } from "./ui.js";

const extensionModule: RuntimeExtensionModule = {
  activate(context: RuntimeExtensionActivationContext): RuntimeExtensionActivation {
    const configured = context.configuration?.endpoint;
    const endpoint = typeof configured === "string" && /^https:\/\//.test(configured) ? configured : DEFAULT_ENDPOINT;
    const scenes = new SceneStore();
    return {
      capabilityProviders: [
        createExcalidrawCapabilityProvider({ mcp: new HostedExcalidrawMcp(endpoint), scenes, execute: context.execute }),
      ],
      uiApplications: [createDiagramUiApplication()],
      dispose: () => scenes.clear(),
    };
  },
};

export const activate: RuntimeExtensionModule["activate"] = (context) => extensionModule.activate(context);

export default extensionModule;
