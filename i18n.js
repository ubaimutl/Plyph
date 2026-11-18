import Gettext from 'gettext';

const DOMAIN = 'plyph';

export function _(message) {
    return Gettext.dgettext(DOMAIN, message);
}

export function N_(message) {
    return message;
}

export function ngettext(singular, plural, count) {
    return Gettext.dngettext(DOMAIN, singular, plural, count);
}

export function format(message, ...values) {
    let index = 0;
    return message.replace(/%(?:(\d+)\$)?([sd%])/g, (_match, position, type) => {
        if (type === '%')
            return '%';
        const value = values[position ? Number(position) - 1 : index++];
        return String(value);
    });
}
