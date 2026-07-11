import { launchWorkspaceDev, normalPorts, printEndpoints } from "./junrei-launcher.mjs";

const ports = normalPorts(process.env);
printEndpoints("start", ports);
launchWorkspaceDev(ports);
