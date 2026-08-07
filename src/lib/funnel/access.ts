/**
 * Точечный доступ к верхней части «Воронка → Клиенты».
 *
 * Полные права по-прежнему определяются ролью admin. Никоненко и Дмитриева
 * получают только клиентский обзор; проверка по каноническому имени из
 * подписанной сессии, поэтому одинаково работает в UI и API.
 */

interface FunnelAccessSubject {
  name: string;
  role: "admin" | "manager";
  department: "b2g" | "b2b";
}

const LIMITED_CLIENT_SURNAMES = new Set(["никоненко", "дмитриева", "дмитриев"]);

function nameTokens(name: string): string[] {
  return name
    .toLocaleLowerCase("ru-RU")
    .replace(/ё/g, "е")
    .split(/[^а-яa-z]+/u)
    .filter(Boolean);
}

/** Пользователь, которому разрешён только верхний клиентский обзор. */
export function hasLimitedFunnelClientsAccess(subject: FunnelAccessSubject): boolean {
  return (
    subject.department === "b2g" &&
    nameTokens(subject.name).some((token) => LIMITED_CLIENT_SURNAMES.has(token))
  );
}

/** Можно ли открыть пункт «Воронка» хотя бы в ограниченном режиме. */
export function canAccessFunnel(subject: FunnelAccessSubject): boolean {
  return subject.role === "admin" || hasLimitedFunnelClientsAccess(subject);
}
