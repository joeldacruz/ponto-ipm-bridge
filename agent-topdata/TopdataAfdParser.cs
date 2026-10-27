using System;
using System.Globalization;

namespace PontoCamara.TopdataAgent
{
    public static class TopdataAfdParser
    {
        public static TopdataEvent ParseAttendance(string deviceId, string line)
        {
            if (line == null)
                throw new ArgumentNullException("line");

            string raw = line.Trim();
            if (raw.Length != 34)
                throw new InvalidOperationException("Registro Topdata com tamanho inesperado.");

            for (int i = 0; i < raw.Length; i++)
                if (!Char.IsDigit(raw[i]))
                    throw new InvalidOperationException("Registro Topdata contem caractere invalido.");

            string nsrText = raw.Substring(0, 9);
            string type = raw.Substring(9, 1);
            string date = raw.Substring(10, 8);
            string time = raw.Substring(18, 4);
            string employee = raw.Substring(22, 12);

            if (type != "3")
                throw new InvalidOperationException("Registro nao e uma marcacao tipo 3.");

            DateTime occurred = DateTime.ParseExact(
                date + time,
                "ddMMyyyyHHmm",
                CultureInfo.InvariantCulture,
                DateTimeStyles.None);

            int nsr = Int32.Parse(nsrText, CultureInfo.InvariantCulture);

            return new TopdataEvent
            {
                sourceId = deviceId + ":" + nsr.ToString(CultureInfo.InvariantCulture),
                nsr = nsr,
                employeeNo = employee,
                occurredAt = occurred.ToString("yyyy-MM-dd'T'HH:mm:ss", CultureInfo.InvariantCulture),
                kind = "ATTENDANCE",
                rawType = type,
                rawPayload = raw
            };
        }
    }
}
