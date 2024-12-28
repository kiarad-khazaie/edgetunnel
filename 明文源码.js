// <!--GAMFC-->version base on commit 841ed4e9ff121dde0ed6a56ae800c2e6c4f66056, time is 2024-04-16 18:02:37 UTC<!--GAMFC-END-->
import { connect } from 'cloudflare:sockets';

// How to generate your own UUID:
// [Windows] Press "Win + R", input cmd and run:  Powershell -NoExit -Command "[guid]::NewGuid()"
let userID = 'd342d11e-d424-4583-b36e-524ab1f0afa4';
let proxyIP = ''; // Optional: Add a specific proxy IP if required

if (!isValidUUID(userID)) {
    throw new Error('uuid is not valid');
}

export default {
    async fetch(request, env, ctx) {
        try {
            userID = env.UUID || userID;
            proxyIP = env.PROXYIP || proxyIP;
            const upgradeHeader = request.headers.get('Upgrade');
            if (!upgradeHeader || upgradeHeader !== 'websocket') {
                const url = new URL(request.url);
                switch (url.pathname) {
                    case '/':
                        return new Response(JSON.stringify(request.cf), { status: 200 });
                    case `/${userID}`: {
                        const vlessConfig = getVLESSConfig(userID, request.headers.get('Host'));
                        return new Response(`${vlessConfig}`, {
                            status: 200,
                            headers: {
                                "Content-Type": "text/plain;charset=utf-8",
                            }
                        });
                    }
                    default:
                        return new Response('Not found', { status: 404 });
                }
            } else {
                return await vlessOverWSHandler(request);
            }
        } catch (err) {
            return new Response(err.toString());
        }
    },
};

// Handles WebSocket connections
async function vlessOverWSHandler(request) {
    const webSocketPair = new WebSocketPair();
    const [client, webSocket] = Object.values(webSocketPair);
    webSocket.accept();

    let address = '';
    const log = (info, event) => {
        console.log(`[${address}] ${info}`, event || '');
    };

    // Read and write data streams
    const readableWebSocketStream = makeReadableWebSocketStream(webSocket, log);
    let remoteSocketWapper = { value: null };

    // WebSocket to Remote Server
    readableWebSocketStream.pipeTo(new WritableStream({
        async write(chunk, controller) {
            if (remoteSocketWapper.value) {
                const writer = remoteSocketWapper.value.writable.getWriter();
                await writer.write(chunk);
                writer.releaseLock();
            } else {
                const {
                    addressRemote,
                    portRemote,
                    rawDataIndex,
                    vlessVersion,
                    hasError,
                    message,
                } = processVlessHeader(chunk, userID);
                if (hasError) {
                    throw new Error(message);
                }
                handleTCPOutBound(remoteSocketWapper, addressRemote, portRemote, chunk.slice(rawDataIndex), webSocket, vlessVersion, log);
            }
        },
        close() {
            log('readableWebSocketStream closed');
        },
        abort(reason) {
            log('readableWebSocketStream aborted', reason);
        },
    })).catch(err => log('readableWebSocketStream pipeTo error', err));

    return new Response(null, { status: 101, webSocket: client });
}

// Process VLESS Header
function processVlessHeader(buffer, userID) {
    if (buffer.byteLength < 24) return { hasError: true, message: 'invalid data' };

    const version = new Uint8Array(buffer.slice(0, 1));
    const isValidUser = stringify(new Uint8Array(buffer.slice(1, 17))) === userID;
    if (!isValidUser) return { hasError: true, message: 'invalid user' };

    const addressLength = buffer[22];
    const addressRemote = new TextDecoder().decode(buffer.slice(23, 23 + addressLength));
    const portRemote = new DataView(buffer.slice(23 + addressLength, 25 + addressLength)).getUint16(0);

    return {
        hasError: false,
        addressRemote,
        portRemote,
        vlessVersion: version,
        rawDataIndex: 25 + addressLength,
    };
}

// TCP Outbound Handling
async function handleTCPOutBound(remoteSocket, address, port, rawClientData, webSocket, vlessVersion, log) {
    try {
        const tcpSocket = connect({ hostname: address, port });
        remoteSocket.value = tcpSocket;
        log(`Connected to ${address}:${port}`);
        const writer = tcpSocket.writable.getWriter();
        await writer.write(rawClientData);
        writer.releaseLock();

        tcpSocket.readable.pipeTo(new WritableStream({
            async write(chunk) {
                if (webSocket.readyState === 1) webSocket.send(chunk);
            },
        })).catch(err => log('TCP Socket error', err));
    } catch (err) {
        log('TCP Outbound error', err);
    }
}

// UUID Validation
function isValidUUID(uuid) {
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[4][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    return uuidRegex.test(uuid);
}

// Generate VLESS Config
function getVLESSConfig(userID, hostName) {
    return `vless://${userID}@${hostName}:443?encryption=none&security=tls&type=ws&host=${hostName}&path=%2Fhidden-path%3Fed%3D2048#${hostName}`;
}
