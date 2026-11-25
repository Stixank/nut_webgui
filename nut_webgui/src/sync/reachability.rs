use crate::config::CustomClient;
use futures::future::join_all;
use std::{collections::HashMap, io::ErrorKind, net::IpAddr, time::Duration};
use tokio::{net::TcpStream, time::timeout};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(1);

/// Checks the clients which have a port. An address is reachable if any of its
/// ports responds. Addresses without a port are not part of the result.
pub async fn check_clients(clients: &[CustomClient]) -> HashMap<IpAddr, bool> {
  let checks = clients.iter().filter_map(|client| {
    client
      .port
      .map(|port| async move { (client.addr, is_reachable(client.addr, port).await) })
  });

  let mut result = HashMap::new();

  for (addr, online) in join_all(checks).await {
    *result.entry(addr).or_insert(false) |= online;
  }

  result
}

/// A refused connection also means that the host is up.
async fn is_reachable(addr: IpAddr, port: u16) -> bool {
  match timeout(CONNECT_TIMEOUT, TcpStream::connect((addr, port))).await {
    Ok(Ok(_)) => true,
    Ok(Err(err)) => err.kind() == ErrorKind::ConnectionRefused,
    Err(_) => false,
  }
}

#[cfg(test)]
mod tests {
  use super::check_clients;
  use crate::config::CustomClient;
  use std::net::TcpListener;

  #[tokio::test]
  async fn checks_only_clients_with_port() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let clients: Vec<CustomClient> = [
      format!("127.0.0.1:{port}"),
      // TEST-NET-1 address, nothing answers there.
      "192.0.2.1:22".to_string(),
      "192.0.2.2".to_string(),
    ]
    .iter()
    .map(|v| v.parse().unwrap())
    .collect();

    let result = check_clients(&clients).await;

    assert_eq!(result.len(), 2);
    assert_eq!(result.get(&clients[0].addr), Some(&true));
    assert_eq!(result.get(&clients[1].addr), Some(&false));
  }
}
