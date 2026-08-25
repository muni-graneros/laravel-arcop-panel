@extends(config('arcop-panel.layout'))

@section('arcop-titulo', 'Bandeja de solicitudes · '.config('arcop-panel.titulo'))

@section('arcop')
    @include('arcop-panel::partes.avisos')

    <div class="arcop-titulo-fila">
        <h1>Solicitudes de datos personales</h1>
        @can(\Muni\Arcop\Permisos::RECIBIR)
            <a class="arcop-boton arcop-boton--principal" href="{{ route('arcop.solicitudes.buscar') }}">
                Recibir una solicitud
            </a>
        @endcan
    </div>

    <form class="arcop-filtros" method="GET" action="{{ route('arcop.solicitudes.index') }}">
        <div class="arcop-campo">
            <label for="filtro-estado">Estado</label>
            <select id="filtro-estado" name="estado">
                <option value="">Todos</option>
                @foreach ($estados as $estado)
                    <option value="{{ $estado->value }}" @selected($filtros['estado'] === $estado->value)>
                        {{ $estado->etiqueta() }}
                    </option>
                @endforeach
            </select>
        </div>

        <div class="arcop-campo">
            <label for="filtro-tipo">Derecho</label>
            <select id="filtro-tipo" name="tipo">
                <option value="">Todos</option>
                @foreach ($tipos as $tipo)
                    <option value="{{ $tipo->value }}" @selected($filtros['tipo'] === $tipo->value)>
                        {{ $tipo->etiqueta() }}
                    </option>
                @endforeach
            </select>
        </div>

        <div class="arcop-campo">
            <label for="filtro-plazo">Plazo</label>
            <select id="filtro-plazo" name="plazo">
                <option value="">Todas</option>
                <option value="pendientes" @selected($filtros['plazo'] === 'pendientes')>Sin resolver</option>
                <option value="por_vencer" @selected($filtros['plazo'] === 'por_vencer')>Por vencer</option>
                <option value="vencidas" @selected($filtros['plazo'] === 'vencidas')>Vencidas</option>
            </select>
        </div>

        <button class="arcop-boton" type="submit">Filtrar</button>
    </form>

    @if ($solicitudes->isEmpty())
        <p class="arcop-vacio">No hay solicitudes que mostrar con esos filtros.</p>
    @else
        <div class="arcop-tabla-marco">
            <table class="arcop-tabla">
                <caption class="arcop-sr">Solicitudes ordenadas por fecha de vencimiento</caption>
                <thead>
                    <tr>
                        <th scope="col">N.º</th>
                        <th scope="col">Titular</th>
                        <th scope="col">Derecho</th>
                        <th scope="col">Estado</th>
                        <th scope="col">Vence</th>
                        <th scope="col">Plazo</th>
                        <th scope="col"><span class="arcop-sr">Acciones</span></th>
                    </tr>
                </thead>
                <tbody>
                    @foreach ($solicitudes as $solicitud)
                        @php($plazo = \Muni\Shared\Privacidad\Ciclo\PlazoLegal::de($solicitud))
                        <tr>
                            <td>{{ $solicitud->getKey() }}</td>
                            <td>{{ \Muni\Shared\Privacidad\Ciclo\EtiquetaDeTitular::deLaSolicitud($solicitud) }}</td>
                            <td>{{ $solicitud->tipo->etiqueta() }}</td>
                            <td>
                                <span class="{{ \Muni\Arcop\Vista\Semaforo::claseEstado($solicitud->estado) }}">
                                    {{ $solicitud->estado->etiqueta() }}
                                </span>
                            </td>
                            <td>{{ $solicitud->vence_en->format('d-m-Y') }}</td>
                            <td>
                                {{-- El color nunca va solo: la etiqueta dice lo mismo en texto. --}}
                                <span class="{{ \Muni\Arcop\Vista\Semaforo::clasePlazo($plazo) }}">
                                    {{ $plazo->etiqueta() }}
                                </span>
                            </td>
                            <td>
                                <a href="{{ route('arcop.solicitudes.show', $solicitud) }}">
                                    Ver<span class="arcop-sr"> la solicitud N.º {{ $solicitud->getKey() }}</span>
                                </a>
                            </td>
                        </tr>
                    @endforeach
                </tbody>
            </table>
        </div>

        {{ $solicitudes->links() }}
    @endif
@endsection
