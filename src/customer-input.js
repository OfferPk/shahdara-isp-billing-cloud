const PAKISTAN_MOBILE_PHONE = /^(?:03[0-9]{9}|\+923[0-9]{9})$/u;

export function validatePakistanPhone(value) {
  if (typeof value !== 'string') {
    throw new TypeError('Phone number must be entered as text.');
  }

  const phone = value.trim();
  if (!phone) return '';
  if (!PAKISTAN_MOBILE_PHONE.test(phone)) {
    throw new Error('Enter a Pakistan mobile number as 03XXXXXXXXX or +923XXXXXXXXX.');
  }
  return phone;
}
