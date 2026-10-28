// Regra única de associação entre a marcação (device_events.employee_no) e o vínculo do servidor
// (employee_device_bindings.device_employee_no). Só leitura: nunca altera device_events.
//
// O parser do Topdata lê o identificador do AFD com 12 posições (raw.Substring(22, 12)), enquanto o PIS/PASEP
// cadastrado tem 11 dígitos. Por isso, além da igualdade exata, aceita-se o identificador de exatamente
// 12 dígitos iniciado por '0' cujos 11 últimos dígitos sejam o device_employee_no do vínculo.
export function employeeNoMatchSql(binding = 'b', event = 'e'): string {
  const ev = `${event}.employee_no`;
  const bd = `${binding}.device_employee_no`;
  return `(${bd} = ${ev}
    OR (length(${ev}) = 12 AND ${ev} NOT GLOB '*[^0-9]*' AND substr(${ev}, 1, 1) = '0' AND substr(${ev}, 2) = ${bd}))`;
}
