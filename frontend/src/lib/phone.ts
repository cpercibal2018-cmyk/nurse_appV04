/** D-35: the server's rule — spaces, hyphens and brackets are ignored, then "+" and 8–15 digits (E.164). */
export const PHONE_E164 = /^\+[1-9]\d{7,14}$/;

export const isPhone = (v: string) => PHONE_E164.test(v.replace(/[\s\-()]/g, ''));

/** antd form rule; an empty value is allowed (the fields are optional). */
export const phoneRule = (message: string) => ({
  validator: (_: unknown, v?: string | null) => (!v || isPhone(v) ? Promise.resolve() : Promise.reject(new Error(message))),
});
