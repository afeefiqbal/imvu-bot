import axios from 'axios';
import * as cheerio from 'cheerio';
import dotenv from 'dotenv';
import { wrapper } from 'axios-cookiejar-support';
import { CookieJar } from 'tough-cookie';

dotenv.config();

const required = ['LOGIN_URL', 'LOGIN_USERNAME', 'LOGIN_PASSWORD'];

for (const key of required) {
    if (!process.env[key]) {
        throw new Error(`Missing ${key}. Set it in your environment or .env file.`);
    }
}

const loginUrl = new URL(process.env.LOGIN_URL);
const loginActionUrl = process.env.LOGIN_ACTION_URL
    ? new URL(process.env.LOGIN_ACTION_URL, loginUrl)
    : null;
const usernameField = process.env.LOGIN_USERNAME_FIELD || 'username';
const passwordField = process.env.LOGIN_PASSWORD_FIELD || 'password';
const csrfField = process.env.LOGIN_CSRF_FIELD || '';
const successUrl = process.env.LOGIN_SUCCESS_URL
    ? new URL(process.env.LOGIN_SUCCESS_URL, loginUrl)
    : null;

const jar = new CookieJar();
const client = wrapper(
    axios.create({
        jar,
        withCredentials: true,
        headers: {
            Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'User-Agent':
                process.env.LOGIN_USER_AGENT ||
                'Mozilla/5.0 (Macintosh; Intel Mac OS X) AppleWebKit/537.36 (KHTML, like Gecko) Chrome Safari/537.36',
        },
    })
);

function findLoginForm($) {
    const configuredSelector = process.env.LOGIN_FORM_SELECTOR;
    if (configuredSelector) {
        const selected = $(configuredSelector).first();
        if (selected.length) return selected;
        throw new Error(`No form matched LOGIN_FORM_SELECTOR=${configuredSelector}`);
    }

    const passwordInput = $('input[type="password"]').first();
    const form = passwordInput.closest('form');

    if (!form.length) {
        throw new Error('Could not find a login form with a password input.');
    }

    return form;
}

function collectFormFields($, form) {
    const fields = new URLSearchParams();

    form.find('input, textarea, select').each((_, element) => {
        const input = $(element);
        const name = input.attr('name');

        if (!name || fields.has(name)) return;

        const type = (input.attr('type') || '').toLowerCase();
        if (['button', 'file', 'image', 'reset', 'submit'].includes(type)) return;
        if ((type === 'checkbox' || type === 'radio') && !input.is(':checked')) return;

        fields.set(name, input.val() ?? '');
    });

    fields.set(usernameField, process.env.LOGIN_USERNAME);
    fields.set(passwordField, process.env.LOGIN_PASSWORD);

    if (csrfField && !fields.has(csrfField)) {
        const token = $(`input[name="${csrfField}"]`).first().val();
        if (token) fields.set(csrfField, token);
    }

    return fields;
}

function resolveActionUrl(form) {
    if (loginActionUrl) return loginActionUrl;

    const action = form.attr('action');
    if (!action) return loginUrl;

    return new URL(action, loginUrl);
}

async function main() {
    const loginPage = await client.get(loginUrl.href);
    const $ = cheerio.load(loginPage.data);
    const form = findLoginForm($);
    const actionUrl = resolveActionUrl(form);
    const fields = collectFormFields($, form);

    const response = await client.post(actionUrl.href, fields, {
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Origin: loginUrl.origin,
            Referer: loginUrl.href,
        },
        maxRedirects: 5,
        validateStatus: (status) => status >= 200 && status < 400,
    });

    const cookies = await jar.getCookies(loginUrl.origin);
    console.log(`Login POST status: ${response.status}`);
    console.log(`Session cookie names: ${cookies.map((cookie) => cookie.key).join(', ') || '(none)'}`);

    if (successUrl) {
        const successResponse = await client.get(successUrl.href);
        console.log(`Success URL status: ${successResponse.status}`);
        console.log(String(successResponse.data).slice(0, 500));
    }
}

main().catch((error) => {
    const status = error.response?.status ? ` HTTP ${error.response.status}` : '';
    console.error(`Login failed:${status} ${error.message}`);
    process.exitCode = 1;
});
