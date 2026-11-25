use self::{
  error::ConfigError, tls_mode::TlsMode, uri_path::UriPath, utils::rand_server_key_256bit,
};
use core::{
  net::{IpAddr, Ipv4Addr, SocketAddr},
  str::FromStr,
};
use serde::Deserialize;
use std::{collections::HashMap, num::NonZeroUsize, path::PathBuf};
use tracing::level_filters::LevelFilter;

mod utils;

pub mod cfg_arg;
pub mod cfg_env;
pub mod cfg_fallback;
pub mod cfg_toml;
pub mod cfg_user;
pub mod error;
pub mod tls_mode;
pub mod uri_path;

pub const DEFAULT_UPSD_KEY: &str = "default";

pub trait ConfigLayer {
  fn apply_layer(self, config: ServerConfig) -> Result<ServerConfig, ConfigError>;
}

pub struct ServerConfig {
  /// Additional config file path
  pub config_file: Option<PathBuf>,

  /// Web GUI default theme
  pub default_theme: Option<Box<str>>,

  /// Logging level
  pub log_level: LevelFilter,

  /// Server instance's private sign key
  pub server_key: Box<[u8]>,

  /// HTTP server configurations
  pub http_server: HttpServerConfig,

  /// UPSD connection configurations
  pub upsd: HashMap<Box<str>, UpsdConfig>,

  /// Authentication scheme configurations
  pub auth: AuthConfig,

  /// Global client filter list
  pub ignore_clients: Box<[IpAddr]>,
}

#[derive(Debug)]
pub struct HttpServerConfig {
  pub listen: IpAddr,
  pub port: u16,
  pub base_path: UriPath,
  pub worker_count: Option<NonZeroUsize>,
}

#[derive(Clone)]
pub struct UpsdConfig {
  /// Poll frequency in seconds for less critical parameters
  pub poll_freq: u64,

  /// Poll interval in seconds for ups status
  pub poll_interval: u64,

  /// UPSD TCP address
  /// It can be hostname, IPv4, or IPv6
  pub addr: Box<str>,

  /// UPSD TCP port
  pub port: u16,

  /// UPSD username
  pub user: Option<Box<str>>,

  /// UPSD password
  pub pass: Option<Box<str>>,

  /// Maximum allowed connection limit aka pool size
  pub max_conn: NonZeroUsize,

  /// UPSD starts with TLS
  pub tls_mode: TlsMode,

  /// UPSD specific client filter.
  pub ignore_clients: Box<[IpAddr]>,

  /// Static clients which are shown as attached to every device of this UPSD,
  /// although UPSD does not report them.
  pub custom_clients: Box<[CustomClient]>,

  /// Row number of this UPSD in the topology view. UPSDs with the same row number are drawn
  /// side by side in one group, rows are drawn from the smallest number to the largest.
  /// Default is `0`.
  pub row: u16,

  /// Custom title of the row in the topology view. If UPSDs in the same row have different
  /// titles, the first one (ordered by UPSD name) is used. Row heading is `Row <row>` if not set.
  pub row_name: Option<Box<str>>,
}

/// A static client from the config: `ip:port` or just `ip`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct CustomClient {
  pub addr: IpAddr,
  /// TCP port for the reachability check, the client is not checked without it.
  pub port: Option<u16>,
}

#[derive(Debug)]
pub struct AuthConfig {
  pub users_file: Option<PathBuf>,
  pub allow_anonymous_metrics: bool,
}

impl AuthConfig {
  pub const fn is_enabled(&self) -> bool {
    self.users_file.is_some()
  }
}

impl UpsdConfig {
  /// Combines clients reported by UPSD with `custom_clients`, and removes the
  /// ignored and duplicate addresses.
  pub fn merge_clients(&self, reported: Vec<IpAddr>) -> Vec<IpAddr> {
    let mut clients = Vec::with_capacity(reported.len() + self.custom_clients.len());

    let custom = self.custom_clients.iter().map(|client| &client.addr);

    for ip in reported.iter().chain(custom) {
      if !self.ignore_clients.contains(ip) && !clients.contains(ip) {
        clients.push(*ip);
      }
    }

    clients
  }

  pub fn get_addr(&self) -> String {
    format!("{address}:{port}", address = self.addr, port = self.port)
  }
}

impl HttpServerConfig {
  pub fn get_listen_addr(&self) -> String {
    format!("{ip}:{port}", ip = self.listen, port = self.port)
  }
}

impl FromStr for CustomClient {
  type Err = String;

  fn from_str(value: &str) -> Result<Self, Self::Err> {
    if let Ok(socket) = value.parse::<SocketAddr>() {
      Ok(Self {
        addr: socket.ip(),
        port: Some(socket.port()),
      })
    } else if let Ok(addr) = value.parse::<IpAddr>() {
      Ok(Self { addr, port: None })
    } else {
      Err(format!(
        "invalid client address '{value}', expected 'ip:port' or 'ip'"
      ))
    }
  }
}

impl<'de> Deserialize<'de> for CustomClient {
  fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
  where
    D: serde::Deserializer<'de>,
  {
    String::deserialize(deserializer)?
      .parse()
      .map_err(serde::de::Error::custom)
  }
}

impl Default for AuthConfig {
  fn default() -> Self {
    Self {
      users_file: None,
      allow_anonymous_metrics: false,
    }
  }
}

impl Default for HttpServerConfig {
  fn default() -> Self {
    Self {
      base_path: UriPath::default(),
      listen: Ipv4Addr::UNSPECIFIED.into(),
      port: 9000,
      worker_count: None,
    }
  }
}

impl Default for UpsdConfig {
  fn default() -> Self {
    Self {
      addr: "localhost".into(),
      custom_clients: Box::new([]),
      ignore_clients: Box::new([]),
      max_conn: NonZeroUsize::new(4).expect("static non-zero max_conn is provided as default"),
      pass: None,
      poll_freq: 30,
      poll_interval: 2,
      port: 3493,
      tls_mode: TlsMode::Disable,
      user: None,
      row: 0,
      row_name: None,
    }
  }
}

impl Default for ServerConfig {
  fn default() -> Self {
    Self {
      auth: Default::default(),
      config_file: None,
      default_theme: None,
      http_server: Default::default(),
      ignore_clients: Box::new([]),
      log_level: LevelFilter::INFO,
      server_key: rand_server_key_256bit(),
      upsd: Default::default(),
    }
  }
}

impl ServerConfig {
  #[inline]
  pub fn new() -> Self {
    Self::default()
  }
}

impl ServerConfig {
  #[inline]
  pub fn layer<L>(self, layer: L) -> Result<Self, ConfigError>
  where
    L: ConfigLayer,
  {
    layer.apply_layer(self)
  }
}

impl core::fmt::Debug for UpsdConfig {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    f.debug_struct("UpsdConfig")
      .field("addr", &self.addr)
      .field("port", &self.port)
      .field("max_conn", &self.max_conn)
      .field("poll_freq", &self.poll_freq)
      .field("poll_interval", &self.poll_interval)
      .field("tls_mode", &self.tls_mode)
      .field("ignore_clients", &self.ignore_clients)
      .field("custom_clients", &self.custom_clients)
      .field("pass", &self.pass.as_ref().map(|_| "******"))
      .field("user", &self.user.as_ref().map(|_| "******"))
      .field("row", &self.row)
      .field("row_name", &self.row_name)
      .finish()
  }
}

impl core::fmt::Debug for ServerConfig {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    f.debug_struct("ServerConfig")
      .field("auth", &self.auth)
      .field("config_file", &self.config_file)
      .field("default_theme", &self.default_theme)
      .field("http_server", &self.http_server)
      .field("ignore_clients", &self.ignore_clients)
      .field("log_level", &self.log_level)
      .field("server_key", &"******")
      .field("upsd", &self.upsd)
      .finish()
  }
}

#[cfg(test)]
mod tests {
  use super::{CustomClient, UpsdConfig, cfg_toml::ServerTomlArgs};
  use core::net::IpAddr;

  fn ip(value: &str) -> IpAddr {
    value.parse().unwrap()
  }

  fn client(value: &str) -> CustomClient {
    value.parse().unwrap()
  }

  #[test]
  fn custom_client_formats() {
    assert_eq!(
      client("192.168.2.23:22"),
      CustomClient {
        addr: ip("192.168.2.23"),
        port: Some(22)
      }
    );
    assert_eq!(
      client("[2001:db8::1]:443"),
      CustomClient {
        addr: ip("2001:db8::1"),
        port: Some(443)
      }
    );
    assert_eq!(
      client("2001:db8::1"),
      CustomClient {
        addr: ip("2001:db8::1"),
        port: None
      }
    );
    assert!("192.168.2.23:99999".parse::<CustomClient>().is_err());
    assert!("netapp:22".parse::<CustomClient>().is_err());
  }

  #[test]
  fn custom_clients_from_toml() {
    let args: ServerTomlArgs = toml::from_str(
      r#"
        [upsd.ippon]
        custom_clients = ["192.168.2.23:22", "192.168.2.24"]
      "#,
    )
    .unwrap();
    let clients = args.upsd.unwrap()["ippon"].custom_clients.clone().unwrap();

    assert_eq!(
      clients.into_iter().collect::<Vec<_>>(),
      vec![client("192.168.2.23:22"), client("192.168.2.24")]
    );
  }

  #[test]
  fn merge_clients_removes_ignored_and_duplicates() {
    let config = UpsdConfig {
      custom_clients: Box::new([
        client("10.0.0.1:22"),
        client("10.0.0.2:22"),
        client("10.0.0.9"),
      ]),
      ignore_clients: Box::new([ip("10.0.0.9")]),
      ..Default::default()
    };

    assert_eq!(
      config.merge_clients(vec![ip("10.0.0.1"), ip("10.0.0.9")]),
      vec![ip("10.0.0.1"), ip("10.0.0.2")]
    );
  }
}
