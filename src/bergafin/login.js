/**
 * Bergafin: login pelo Authentik na tela de login.
 *
 * Depende do plugin Bergafin Auth no servidor (https://github.com/Agelinena/Bergafin-auth):
 *   GET  /Bergafin/Info                 -> { Configured }
 *   GET  /Bergafin/Login?mode=webfork&state=…  -> Authentik -> /web/#/login?bergafinTicket=…&bergafinState=…
 *   POST /Bergafin/Exchange             -> troca o ticket por uma sessão
 *
 * Fica num módulo próprio para o código oficial ganhar só alguns ganchos
 * (o rebase automático quase nunca conflita).
 */
import { appHost } from 'components/apphost';
import appSettings from 'scripts/settings/appSettings';
import loading from 'components/loading/loading';
import toast from 'components/toast/toast';

let available = false;
const handledTickets = new Set();

/** O botão do Authentik está ativo neste servidor. */
export function isBergafinAvailable() {
    return available;
}

/** Pergunta ao servidor se o plugin está configurado e mostra o botão. */
export function checkBergafin(view, apiClient) {
    return fetch(apiClient.getUrl('Bergafin/Info'), { headers: { Accept: 'application/json' } })
        .then(res => (res.ok ? res.json() : null))
        .catch(() => null)
        .then(info => {
            available = !!info?.Configured;
            view.querySelector('.btnBergafin')?.classList.toggle('hide', !available);
            // Contas do Authentik não têm senha no Jellyfin: "esqueci a senha" não faz sentido
            view.querySelector('.btnForgotPassword')?.classList.toggle('hide', available);
            view.querySelector('.bergafinLocalHint')?.classList.toggle('hide', !available);
            return available;
        });
}

const STATE_KEY = 'bergafinLoginState';
const STATE_TTL_MS = 15 * 60 * 1000;

/**
 * Valor aleatório guardado só neste navegador/app. Ele volta junto com o ticket, e o
 * ticket só é aceito se o state for este: um link de terceiros com o ticket de outra
 * conta não consegue fazer este aparelho entrar nela.
 */
function newLoginState() {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    const state = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    try {
        localStorage.setItem(STATE_KEY, JSON.stringify({ state, at: Date.now() }));
    } catch (err) {
        console.error('[Bergafin] não deu para guardar o state do login', err);
    }
    return state;
}

/** Confere (e consome) o state que voltou com o ticket. */
function takeLoginState(state) {
    let saved = null;
    try {
        saved = JSON.parse(localStorage.getItem(STATE_KEY));
        localStorage.removeItem(STATE_KEY);
    } catch {
        saved = null;
    }
    return !!state && !!saved && saved.state === state && Date.now() - saved.at < STATE_TTL_MS;
}

/** Leva ao Authentik. No app Bergafin (Android), o app abre o navegador do sistema. */
export function startBergafinLogin(apiClient) {
    const state = newLoginState();
    if (window.NativeShell?.Bergafin?.login) {
        window.NativeShell.Bergafin.login(apiClient.serverAddress(), state);
        return;
    }
    window.location.href = apiClient.getUrl('Bergafin/Login') + '?mode=webfork&state=' + encodeURIComponent(state);
}

/**
 * Se a tela de login abriu com ?bergafinTicket=…, troca o ticket por uma sessão.
 * Devolve true se havia ticket (a tela não deve mostrar o formulário).
 */
export function handleBergafinTicket(params, apiClient, onSuccess, fallback) {
    const ticket = params.bergafinTicket;
    if (!ticket) {
        return false;
    }

    // A tela pode disparar "viewshow" mais de uma vez; o ticket é de uso único
    if (handledTickets.has(ticket)) {
        return true;
    }
    handledTickets.add(ticket);

    if (!takeLoginState(params.bergafinState)) {
        console.warn('[Bergafin] ticket recusado: o login não foi iniciado neste aparelho');
        toast('Login recusado: ele não foi iniciado neste aparelho. Clique em "Entrar com Authentik".');
        window.history.replaceState(null, '', window.location.pathname + '#/login');
        fallback?.();
        return true;
    }

    loading.show();
    Promise.resolve(appHost.deviceId())
        .then(deviceId => fetch(apiClient.getUrl('Bergafin/Exchange'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({
                Ticket: ticket,
                DeviceId: deviceId,
                DeviceName: appHost.deviceName(),
                App: appHost.appName(),
                AppVersion: appHost.appVersion()
            })
        }))
        .then(res => {
            if (!res.ok) {
                throw new Error('Exchange ' + res.status);
            }
            return res.json();
        })
        .then(result => {
            appSettings.enableAutoLogin(true);
            // Grava o token na lista de servidores, como o login com senha e o Quick
            // Connect fazem (connectionManager.onAuthenticated). Sem isso, a tela inicial
            // não acha a sessão e volta para o login.
            return Promise.resolve(apiClient.onAuthenticated?.(apiClient, result)).then(() => result);
        })
        .then(result => {
            loading.hide();
            onSuccess(result.User.Id, result.AccessToken);
        })
        .catch(err => {
            loading.hide();
            console.error('[Bergafin] falha ao trocar o ticket', err);
            toast('O login pelo Authentik expirou. Clique em "Entrar com Authentik" de novo.');
            // Mostra a tela de login normal (sem recarregar e sem repetir o ticket)
            window.history.replaceState(null, '', window.location.pathname + '#/login');
            fallback?.();
        });
    return true;
}
