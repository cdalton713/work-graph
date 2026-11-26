//! Match json.dump(indent=2) because the Python CLI hashes state file bytes.
use serde::Serialize;
use serde_json::{
    Serializer, Value,
    ser::{Formatter, PrettyFormatter},
};
use std::io::{self, Write};

pub fn write_pretty_json(writer: impl Write, value: &Value) -> io::Result<()> {
    let mut writer = io::BufWriter::new(writer);
    value.serialize(&mut Serializer::with_formatter(
        &mut writer,
        AsciiPretty(PrettyFormatter::new()),
    ))?;
    writer.write_all(b"\n")?;
    writer.flush()
}

struct AsciiPretty(PrettyFormatter<'static>);

// Delegate indentation and separators to serde_json.
macro_rules! delegate {
    ($name:ident $(, $flag:ident)?) => {
        fn $name<W: ?Sized + Write>(&mut self, writer:&mut W $(, $flag:bool)?) -> io::Result<()> {
            self.0.$name(writer $(,$flag)?)
        }
    }
}

impl Formatter for AsciiPretty {
    delegate!(begin_array);
    delegate!(end_array);
    delegate!(begin_array_value, first);
    delegate!(end_array_value);
    delegate!(begin_object);
    delegate!(end_object);
    delegate!(begin_object_key, first);
    delegate!(begin_object_value);
    delegate!(end_object_value);

    fn write_string_fragment<W: ?Sized + Write>(
        &mut self,
        writer: &mut W,
        text: &str,
    ) -> io::Result<()> {
        let mut start = 0;
        for (i, ch) in text.char_indices().filter(|(_, ch)| *ch >= '\u{7f}') {
            writer.write_all(&text.as_bytes()[start..i])?;
            for unit in ch.encode_utf16(&mut [0; 2]) {
                write!(writer, "\\u{unit:04x}")?;
            }
            start = i + ch.len_utf8();
        }
        writer.write_all(&text.as_bytes()[start..])
    }

    fn write_f64<W: ?Sized + Write>(&mut self, writer: &mut W, value: f64) -> io::Result<()> {
        if value.is_sign_negative() {
            writer.write_all(b"-")?;
        }
        if value == 0.0 {
            return writer.write_all(b"0.0");
        }
        // serde supplies the shortest round-trip digits. Python switches to
        // scientific notation at decimal exponents below -4 or at least 16.
        let shortest = serde_json::Number::from_f64(value.abs())
            .expect("finite JSON number")
            .to_string();
        let (mantissa, exp) = shortest
            .split_once('e')
            .map_or((shortest.as_str(), 0), |(m, e)| {
                (m, e.parse::<i32>().expect("decimal exponent"))
            });
        let point = mantissa.find('.').unwrap_or(mantissa.len());
        let digits = mantissa.replace('.', "");
        let significant = digits.trim_start_matches('0');
        let exp = exp + point as i32 - (digits.len() - significant.len()) as i32 - 1;
        let digits = significant.trim_end_matches('0');
        if !(-4..16).contains(&exp) {
            writer.write_all(&digits.as_bytes()[..1])?;
            if digits.len() > 1 {
                write!(writer, ".{}", &digits[1..])?;
            }
            write!(writer, "e{exp:+03}")
        } else if exp < 0 {
            write!(writer, "0.{}{digits}", "0".repeat((-exp - 1) as usize))
        } else {
            let point = exp as usize + 1;
            if point >= digits.len() {
                write!(writer, "{digits}{}.0", "0".repeat(point - digits.len()))
            } else {
                write!(writer, "{}.{}", &digits[..point], &digits[point..])
            }
        }
    }
}
