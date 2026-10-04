<?php

namespace Muni\Arcop\Recepcion;

use Illuminate\Contracts\Session\Session;

/**
 * Los titulares que ESTA sesión encontró buscando, referidos por una clave
 * opaca.
 *
 * La clave real del titular —en atencionvecino es el RUT— no viaja en ninguna
 * URL: ni en el enlace «Elegir» de los resultados ni en el formulario del paso
 * 2. Lo que viaja es una referencia aleatoria que solo esta sesión sabe
 * traducir. Con eso el paso 2 deja de ser una superficie por donde enumerar el
 * padrón (no hay clave que adivinar: una referencia que no salió de una
 * búsqueda de esta sesión es un 404, igual que una inventada), y el RUT deja
 * de quedar en el access log y en el historial del navegador compartido del
 * mesón.
 *
 * Aleatoria pura y no un ULID ni un UUIDv7: acá no se necesita orden, se
 * necesita opacidad (el mismo criterio que `Bitacora::desvincular()` en
 * muni-shared, donde la marca de tiempo del ULID volvía a la persona).
 *
 * No es singleton a propósito: guarda la sesión de la petición en curso y en
 * Octane un singleton la arrastraría a la siguiente.
 */
final class TitularesBuscados
{
    /** Cuántas referencias recuerda la sesión: cinco búsquedas llenas. */
    private const MAXIMO = 100;

    private const CLAVE_TITULARES = 'arcop.titulares';

    private const CLAVE_BUSQUEDA = 'arcop.busqueda';

    public function __construct(private readonly Session $sesion) {}

    /**
     * Guarda lo que devolvió una búsqueda y entrega los resultados ya referidos.
     *
     * Un titular que ya tenía referencia en esta sesión conserva la misma: el
     * funcionario que busca dos veces a la misma persona no acumula entradas.
     *
     * @param  array<int|string, string>  $resultados  clave del titular => etiqueta visible
     * @return array<string, string> referencia => etiqueta visible
     */
    public function recordar(string $termino, array $resultados): array
    {
        $titulares = $this->titulares();
        $visibles = [];

        foreach ($resultados as $clave => $etiqueta) {
            $referencia = array_search($clave, $titulares, true);

            if ($referencia === false) {
                $referencia = bin2hex(random_bytes(16));
                $titulares[$referencia] = $clave;
            }

            $visibles[(string) $referencia] = $etiqueta;
        }

        $this->sesion->put(self::CLAVE_TITULARES, array_slice($titulares, -self::MAXIMO, null, true));
        $this->sesion->put(self::CLAVE_BUSQUEDA, ['termino' => $termino, 'resultados' => $visibles]);

        return $visibles;
    }

    /**
     * Lo que la última búsqueda de esta sesión tipeó y encontró, para volver a
     * pintarlo después de la redirección.
     *
     * @return array{termino: string, resultados: array<string, string>}
     */
    public function ultimaBusqueda(): array
    {
        $busqueda = $this->sesion->get(self::CLAVE_BUSQUEDA);

        if (! is_array($busqueda)) {
            return ['termino' => '', 'resultados' => []];
        }

        $resultados = $busqueda['resultados'] ?? [];

        return [
            'termino' => (string) ($busqueda['termino'] ?? ''),
            'resultados' => is_array($resultados) ? $resultados : [],
        ];
    }

    /** La clave real detrás de una referencia, o `null` si esta sesión no la emitió. */
    public function claveDe(string $referencia): int|string|null
    {
        $titulares = $this->titulares();

        if (! array_key_exists($referencia, $titulares)) {
            return null;
        }

        $clave = $titulares[$referencia];

        return is_int($clave) || is_string($clave) ? $clave : null;
    }

    /** Recibida la solicitud, la sesión no tiene por qué seguir sabiendo a quién se buscó. */
    public function olvidar(): void
    {
        $this->sesion->forget([self::CLAVE_TITULARES, self::CLAVE_BUSQUEDA]);
    }

    /** @return array<string, mixed> referencia => clave del titular */
    private function titulares(): array
    {
        $titulares = $this->sesion->get(self::CLAVE_TITULARES, []);

        return is_array($titulares) ? $titulares : [];
    }
}
