/**
 * Bergafin: login pelo Authentik na tela de login.
 *
 * Depende do plugin Bergafin Auth no servidor (https://github.com/Agelinena/Bergafin-auth):
 *   GET  /Bergafin/Info                 -> { Configured }
 *   GET  /Bergafin/Login?mode=webfork   -> Authentik -> /web/#/login?bergafinTicket=…
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

/** Leva ao Authentik. No app Bergafin (Android), o app abre o navegador do sistema. */
export function startBergafinLogin(apiClient) {
    if (window.NativeShell?.Bergafin?.login) {
        window.NativeShell.Bergafin.login(apiClient.serverAddress());
        return;
    }
    window.location.href = apiClient.getUrl('Bergafin/Login') + '?mode=webfork';
}

/**
 * Se a tela de login abriu com ?bergafinTicket=…, troca o ticket por uma sessão.
 * Devolve true se havia ticket (a tela não deve mostrar o formulário).
 */
export function handleBergafinTicket(params, apiClient, onSuccess) {
    const ticket = params.bergafinTicket;
    if (!ticket) {
        return false;
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
            loading.hide();
            appSettings.enableAutoLogin(true);
            onSuccess(result.User.Id, result.AccessToken);
        })
        .catch(err => {
            loading.hide();
            console.error('[Bergafin] falha ao trocar o ticket', err);
            toast('O login pelo Authentik expirou. Tente de novo.');
            // Volta para a tela de login normal, sem o ticket
            window.location.replace(window.location.pathname + '#/login');
        });
    return true;
}
