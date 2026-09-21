// Run from the repository root: gjs -m tests/compatible-integration.js
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';
import {AiClient} from '../ai.js';
import {fetchModels, compatibleEndpoint} from '../models.js';

function assert(value, message) {
    if (!value)
        throw new Error(message);
}

const server = new Soup.Server();
const received = [];
server.add_handler(null, (_server, message, path) => {
    received.push(path);
    assert(!message.get_request_headers().get_one('Authorization'), 'Unexpected authentication');
    let response;
    if (path === '/prefix/v1/models') {
        response = {data: [{id: 'local/test'}]};
    } else if (path === '/prefix/v1/chat/completions') {
        const body = JSON.parse(new TextDecoder().decode(message.get_request_body().flatten().get_data()));
        assert(body.model === 'local/test', 'Model mismatch');
        assert(body.stream === false, 'Streaming must be disabled');
        assert(body.messages[0].content === 'Hello', 'Prompt mismatch');
        response = {choices: [{message: {content: 'Success'}, finish_reason: 'stop'}]};
    } else {
        message.set_status(404, null);
        return;
    }
    message.set_status(200, null);
    message.set_response('application/json', Soup.MemoryUse.COPY, JSON.stringify(response));
});
server.listen_local(0, Soup.ServerListenOptions.IPV4_ONLY);
const values = {
    provider: 'openai-compatible',
    'openai-compatible-url': `${server.get_uris()[0].to_string()}prefix/v1/`,
    'openai-compatible-model': 'local/test',
};
const settings = {get_string: key => values[key] ?? '', get_boolean: () => false};
const client = new AiClient(settings);
const loop = new GLib.MainLoop(null, false);
let failure;
(async () => {
    try {
        for (const url of ['ftp://host/v1', 'http://user@host/v1', 'http://host/v1?', 'http://host/v1#', 'http://host:99999/v1']) {
            const invalid = {get_string: () => url};
            let rejected = false;
            try { compatibleEndpoint(invalid, 'models'); } catch { rejected = true; }
            assert(rejected, `Accepted invalid URL: ${url}`);
        }
        const models = await fetchModels(settings, 'openai-compatible');
        assert(models[0].id === 'local/test', 'Discovery failed');
        const output = await client.transform('Hello', 'prompt', '');
        assert(output === 'Success', 'Generation failed');
        assert(received.length === 2, 'Unexpected request count');
        print('GJS/Soup integration passed: discovery and generation without authentication');
    } catch (error) {
        failure = error;
    } finally {
        client.destroy();
        server.disconnect();
        loop.quit();
    }
})();
loop.run();
if (failure)
    throw failure;
